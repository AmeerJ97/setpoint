/**
 * `claude-ops consolidate` — rough engram-lite CLI.
 *
 * Subcommands:
 *   scan [--include L] [--exclude P] [--sim F] [--haiku-budget N] [--no-haiku] [--json]
 *   apply --id PROP [--yes]
 *   apply --all --confirm
 *   undo [--last | --ts TS]
 *   status [--json]
 */

import { enumerate, countByKind, DEFAULT_ROOTS } from '../consolidate/sources.js';
import { makeBm25PairScore, clusterBySimilarity, clusterByNeighbors } from '../consolidate/cluster.js';
import { qmdAvailable, ensureCollection, refresh as qmdRefresh, makeQmdNeighborsFn } from '../consolidate/qmd-bridge.js';
import { claudeAvailable, mergeDuplicates, promoteMemory } from '../consolidate/haiku.js';
import {
  loadStore, saveStore, reconcile, PROPOSALS_FILE,
} from '../consolidate/propose.js';
import { applyProposal, undo as undoLast } from '../consolidate/apply.js';
import { reviewInteractive } from '../consolidate/review.js';
import { decideScan, cachedProbe, loadGateState, saveGateState } from '../consolidate/gate.js';
import { getClaudeConfigDir } from '../data/paths.js';

export async function main(argv = []) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'scan':   return cmdScan(rest);
    case 'review': return reviewInteractive(parseArgs(rest));
    case 'apply':  return cmdApply(rest);
    case 'undo':   return cmdUndo(rest);
    case 'status': return cmdStatus(rest);
    case 'help': case '--help': case '-h': case undefined:
      printUsage();
      return 0;
    default:
      process.stderr.write(`claude-ops consolidate: unknown subcommand '${sub}'\n`);
      printUsage();
      return 2;
  }
}

function cmdScan(argv) {
  const opts = parseArgs(argv);
  const showProgress = !opts.json;
  progress(showProgress, 'discovering artifacts');
  const artifacts = enumerate({
    kinds: opts.include ?? ['skills', 'commands', 'agents', 'memory'],
    excludes: opts.exclude ?? [],
  });
  const sources = countByKind(artifacts);
  progress(showProgress, `found ${artifacts.length} artifacts (${JSON.stringify(sources)})`);

  // Fast path: when nothing to scan, write an empty store and exit.
  if (artifacts.length === 0) {
    saveStore(reconcile([], sources));
    if (opts.json) process.stdout.write(JSON.stringify({ proposals: 0, sources }) + '\n');
    else process.stdout.write('claude-ops consolidate: no artifacts found under configured roots.\n');
    return 0;
  }

  // Novelty gate: skip the expensive pass when the corpus has barely
  // shifted since the last run. Caches probe results so we don't hit
  // PATH every invocation either.
  const gateState = loadGateState();
  const threshold = Number.isFinite(opts.novelty) ? opts.novelty : 0.02;
  const gate = decideScan({ artifacts, threshold, state: gateState });
  progress(showProgress, `novelty ${gate.delta.novelty.toFixed(3)} (${gate.delta.added.length}+${gate.delta.changed.length}+${gate.delta.removed.length} shifted)`);
  if (gate.skip && !opts.force) {
    gateState.snapshot = gate.snapshot;
    gateState.lastScanAt = Date.now();
    saveGateState(gateState);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: gate.reason, delta: gate.delta, sources }) + '\n');
    } else {
      process.stdout.write(`claude-ops consolidate: skipped — ${gate.reason}. Pass --force to override.\n`);
    }
    return 0;
  }

  const { ok: useQmd }    = cachedProbe('qmd',    qmdAvailable,   gateState);
  const { ok: haveClaude } = cachedProbe('claude', claudeAvailable, gateState);
  progress(showProgress, `helpers qmd:${useQmd ? 'yes' : 'no'} haiku:${haveClaude && !opts.noHaiku ? 'yes' : 'no'}`);

  // Scorer selection:
  //   --qmd             → vector neighbors (semantic, slower, opt-in)
  //   BM25 (default)    → pairwise tokens (lexical, fast)
  //
  // qmd mode falls back to BM25 per-artifact when qmd returns no hits,
  // so a misconfigured collection doesn't silently drop coverage.
  const pairScore = makeBm25PairScore(artifacts);
  const sim = typeof opts.sim === 'number' ? opts.sim : 0.45;

  let clusters, scorer = 'bm25';
  // --qmd is HARD-GATED behind CLAUDE_OPS_QMD_DANGEROUS_ENABLE=1. The
  // qmd refresh+vsearch path spawns a GGUF embedder that can pin every
  // CPU core and trigger thermal throttling. Treated as explicit
  // opt-in only. See src/consolidate/qmd-bridge.js for the per-process
  // mitigations (thread caps, nice, idle ionice, aggressive timeouts).
  const qmdConsent = process.env.CLAUDE_OPS_QMD_DANGEROUS_ENABLE === '1';
  if (opts.qmd && !qmdConsent) {
    process.stderr.write(
      'claude-ops consolidate: --qmd refused.\n' +
      '  The qmd path spawns a local GGUF embedder that can pin every CPU core\n' +
      '  for minutes and trigger thermal throttling. To enable explicitly:\n' +
      '    CLAUDE_OPS_QMD_DANGEROUS_ENABLE=1 claude-ops consolidate scan --qmd\n' +
      '  The BM25 path (default) handles overlap detection without any subprocess.\n'
    );
    return 2;
  }
  if (opts.qmd && useQmd && qmdConsent) {
    progress(showProgress, 'preparing qmd collections');
    const prep = prepareQmd(artifacts);
    if (prep.ok) {
      const vsim = typeof opts.sim === 'number' ? opts.sim : 0.55; // vector scores trend lower
      progress(showProgress, 'clustering artifacts with qmd + bm25 fallback');
      clusters = clusterByNeighbors(artifacts, makeQmdNeighborsFn({ k: 5 }), pairScore, vsim);
      scorer = 'qmd+bm25-fallback';
    } else {
      process.stderr.write(`claude-ops consolidate: qmd prep failed (${prep.reason}); falling back to BM25\n`);
      progress(showProgress, 'qmd prep failed; falling back to bm25 clustering');
      clusters = clusterBySimilarity(artifacts, pairScore, sim);
    }
  } else {
    progress(showProgress, 'clustering artifacts with bm25');
    clusters = clusterBySimilarity(artifacts, pairScore, sim);
  }

  // Build overlap proposals.
  const fresh = [];
  for (const cl of clusters) {
    const members = [cl.canonical, ...cl.members.filter(m => m !== cl.canonical)];
    const sourcesPaths = members.map(m => m.realPath);
    fresh.push({
      kind: 'merge_overlap',
      confidence: 0.8,
      sources: sourcesPaths,
      target: cl.canonical.realPath,
      diffPreview: previewCluster(members),
      haikuOutput: null,
      autoApplyable: false,
      reason: `${members.length} overlapping ${cl.canonical.kind}s (sim≥${sim})`,
    });
  }

  // Haiku enrichment (bounded budget). Use the cached probe result
  // rather than re-hitting PATH.
  const useHaiku = !opts.noHaiku && haveClaude;
  let budget = Number.isFinite(opts.haikuBudget) ? opts.haikuBudget : 25;
  let haikuUsed = 0;

  if (useHaiku) {
    progress(showProgress, `running haiku enrichment (budget ${budget})`);
    for (const proposal of fresh) {
      if (budget <= 0) break;
      if (proposal.kind !== 'merge_overlap') continue;
      const memberRecs = proposal.sources.map(p => artifacts.find(a => a.realPath === p)).filter(Boolean);
      const { ok, proposal: hp } = mergeDuplicates(memberRecs);
      if (ok) {
        proposal.haikuOutput = hp;
        proposal.autoApplyable = false; // still gate on user confirm
      }
      budget--; haikuUsed++;
    }
    // Promote-memory pass.
    const memoryRecs = artifacts.filter(a => a.kind === 'memory_global' || a.kind === 'memory_project');
    for (const mem of memoryRecs) {
      if (budget <= 0) break;
      const { ok, proposal: hp } = promoteMemory(mem);
      if (!ok) { budget--; haikuUsed++; continue; }
      if (hp.promote_to && hp.promote_to !== 'none' && hp.cleaned_body) {
        const target = proposeTargetPath(hp.promote_to, hp.proposed_name);
        if (target) {
          fresh.push({
            kind: 'promote_memory',
            confidence: 0.7,
            sources: [mem.realPath],
            target,
            diffPreview: `promote ${mem.path} → ${target}`,
            haikuOutput: hp,
            autoApplyable: false,
            reason: `memory → ${hp.promote_to} '${hp.proposed_name}'`,
          });
        }
      }
      budget--; haikuUsed++;
    }
  }

  const store = reconcile(fresh, sources);
  progress(showProgress, `writing ${store.proposals.filter(p => p.status === 'pending').length} pending proposal(s)`);
  saveStore(store);

  // Persist the new snapshot so the next run's gate has a reference.
  gateState.snapshot = gate.snapshot;
  gateState.lastScanAt = Date.now();
  saveGateState(gateState);

  const pending = store.proposals.filter(p => p.status === 'pending').length;
  const applied = store.proposals.filter(p => p.status === 'applied').length;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: true, sources, clusters: clusters.length,
      pending, applied,
      qmd: useQmd, haiku: useHaiku, haikuUsed, scorer,
      novelty: gate.delta.novelty,
      churn: { added: gate.delta.added.length, changed: gate.delta.changed.length, removed: gate.delta.removed.length },
      file: PROPOSALS_FILE,
    }, null, 2) + '\n');
  } else {
    process.stdout.write(`\nclaude-ops consolidate scan\n${'─'.repeat(60)}\n`);
    process.stdout.write(`  Sources:   ${JSON.stringify(sources)}\n`);
    process.stdout.write(`  Novelty:   ${gate.delta.novelty.toFixed(3)}  (${gate.delta.added.length}+${gate.delta.changed.length}+${gate.delta.removed.length} paths shifted)\n`);
    process.stdout.write(`  Clusters:  ${clusters.length}\n`);
    process.stdout.write(`  Proposals: ${pending} pending, ${applied} applied\n`);
    process.stdout.write(`  Scorer:    ${scorer}\n`);
    process.stdout.write(`  qmd:       ${useQmd ? 'available (cached)' : 'absent (cached)'}\n`);
    process.stdout.write(`  haiku:     ${useHaiku ? `used ${haikuUsed} call(s)` : 'disabled'}\n`);
    process.stdout.write(`  File:      ${PROPOSALS_FILE}\n\n`);
    process.stdout.write(`Next: claude-ops consolidate review   |   apply --id <prop-NNNN>\n`);
  }
  return 0;
}

function progress(enabled, message) {
  if (!enabled) return;
  process.stdout.write(`scan: ${message}\n`);
}

/**
 * Register the four source roots with qmd and run update + embed once.
 * Idempotent — existing collections are no-ops.
 *
 * @param {Array<object>} artifacts
 * @returns {{ ok: boolean, reason: string }}
 */
function prepareQmd(artifacts) {
  const roots = [
    { name: 'claude-ops-skills',   path: DEFAULT_ROOTS.skills },
    { name: 'claude-ops-commands', path: DEFAULT_ROOTS.commands },
    { name: 'claude-ops-agents',   path: DEFAULT_ROOTS.agents },
  ];
  for (const { name, path } of roots) {
    const r = ensureCollection(name, path);
    if (!r.ok) return { ok: false, reason: `${name}: ${r.reason}` };
  }
  const ref = qmdRefresh();
  return ref;
}

function cmdApply(argv) {
  const opts = parseArgs(argv);
  if (!experimentalApplyAllowed(opts)) {
    process.stderr.write(
      'claude-ops consolidate apply is experimental and mutates Claude artifacts.\n' +
      '  Re-run with --experimental or CLAUDE_OPS_EXPERIMENTAL=1 after reviewing proposals.\n'
    );
    return 2;
  }
  if (opts.all) {
    if (!opts.confirm) {
      process.stderr.write('claude-ops consolidate apply --all requires --confirm\n');
      return 2;
    }
    const store = loadStore();
    let applied = 0, failed = 0;
    for (const p of store.proposals.filter(p => p.status === 'pending')) {
      const r = applyProposal(p.id, { yes: true });
      if (r.ok) applied++;
      else { failed++; process.stderr.write(`  ${p.id}: ${r.reason}\n`); }
    }
    process.stdout.write(`applied ${applied}, failed ${failed}\n`);
    return failed > 0 ? 1 : 0;
  }
  if (!opts.id) {
    process.stderr.write('claude-ops consolidate apply requires --id PROP (or --all --confirm)\n');
    return 2;
  }
  const r = applyProposal(opts.id, { yes: !!opts.yes });
  process.stdout.write(`${r.ok ? 'applied' : 'FAILED'}: ${r.reason}${r.bakDir ? `\n  backup: ${r.bakDir}` : ''}\n`);
  return r.ok ? 0 : 1;
}

function cmdUndo(argv) {
  const opts = parseArgs(argv);
  const r = undoLast({ ts: opts.ts, last: opts.last !== false });
  process.stdout.write(`${r.ok ? 'undo' : 'FAILED'}: ${r.reason}\n`);
  return r.ok ? 0 : 1;
}

function cmdStatus(argv) {
  const opts = parseArgs(argv);
  const store = loadStore();
  const counts = { pending: 0, applied: 0, dismissed: 0 };
  for (const p of store.proposals) counts[p.status] = (counts[p.status] ?? 0) + 1;
  if (opts.json) {
    process.stdout.write(JSON.stringify({
      generatedAt: store.generatedAt, sources: store.sources, counts,
      proposals: store.proposals.map(p => ({
        id: p.id, kind: p.kind, status: p.status,
        confidence: p.confidence, reason: p.reason,
      })),
    }, null, 2) + '\n');
    return 0;
  }
  process.stdout.write(`\nclaude-ops consolidate status\n${'─'.repeat(60)}\n`);
  process.stdout.write(`  Generated:  ${store.generatedAt || '(never run)'}\n`);
  process.stdout.write(`  Sources:    ${JSON.stringify(store.sources)}\n`);
  process.stdout.write(`  Proposals:  ${counts.pending} pending · ${counts.applied} applied · ${counts.dismissed} dismissed\n\n`);
  for (const p of store.proposals.filter(x => x.status === 'pending').slice(0, 25)) {
    const short = p.reason.length > 60 ? p.reason.slice(0, 57) + '…' : p.reason;
    process.stdout.write(`  ${p.id}  ${p.kind.padEnd(15)}  ${short}\n`);
  }
  return 0;
}

function previewCluster(members) {
  const lines = [`merge ${members.length} artifacts →`];
  for (const m of members) lines.push(`  - ${m.path} (${m.body.length}B)`);
  return lines.join('\n');
}

function proposeTargetPath(kind, name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  const claudeDir = getClaudeConfigDir();
  if (kind === 'skill')   return `${claudeDir}/skills/${slug}/SKILL.md`;
  if (kind === 'command') return `${claudeDir}/commands/${slug}.md`;
  if (kind === 'agent')   return `${claudeDir}/agents/${slug}.md`;
  return null;
}

function experimentalApplyAllowed(opts) {
  return opts.experimental === true || process.env.CLAUDE_OPS_EXPERIMENTAL === '1';
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json':          opts.json = true; break;
      case '--no-haiku':      opts.noHaiku = true; break;
      case '--force':         opts.force = true; break;
      case '--qmd':           opts.qmd = true; break;
      case '--novelty':       opts.novelty = Number(argv[++i]); break;
      case '--all':           opts.all = true; break;
      case '--confirm':       opts.confirm = true; break;
      case '--yes': case '-y':opts.yes = true; break;
      case '--experimental':  opts.experimental = true; break;
      case '--last':          opts.last = true; break;
      case '--include':       opts.include = argv[++i]?.split(',').map(s => s.trim()).filter(Boolean); break;
      case '--exclude':       opts.exclude = (opts.exclude ?? []).concat([argv[++i]]); break;
      case '--sim':           opts.sim = Number(argv[++i]); break;
      case '--haiku-budget':  opts.haikuBudget = Number(argv[++i]); break;
      case '--id':            opts.id = argv[++i]; break;
      case '--ts':            opts.ts = argv[++i]; break;
      default: /* positional / ignored */ break;
    }
  }
  return opts;
}

function printUsage() {
  process.stdout.write(`\
claude-ops consolidate — EXPERIMENTAL rough engram-lite: find overlap, propose merges, promote memory

Usage:
  claude-ops consolidate scan [--include L] [--exclude P] [--sim F]
                            [--haiku-budget N] [--no-haiku] [--json]
    Discover artifacts under ~/.claude/{skills,commands,agents,projects/*/memory},
    cluster by BM25 similarity, optionally enrich with Haiku via the claude CLI,
    and write idempotent proposals to ~/.claude/plugins/claude-ops/consolidate/proposals.json

  claude-ops consolidate status [--json]
    Show pending / applied / dismissed counts + the pending queue.

  claude-ops consolidate apply --id prop-NNNN [--yes]
  claude-ops consolidate apply --all --confirm
    Apply a specific proposal (or every pending one). Atomic writes with
    backups at ~/.claude/plugins/claude-ops/consolidate/backups/<ts>/.
    Requires --experimental or CLAUDE_OPS_EXPERIMENTAL=1.

  claude-ops consolidate undo [--last | --ts YYYY-MM-DDTHH-MM-SS]
    Restore files from a backup generation.

Safety:
  - Sources must be under ~/.claude/; paths outside are rejected.
  - Every apply copies existing files to backups/<ts>/ first.
  - Haiku is called only when the 'claude' CLI is on PATH.
  - Nothing is deleted without explicit --confirm or a matching proposal.
`);
}
