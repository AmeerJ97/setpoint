/**
 * Interactive review walker.
 *
 * For each pending proposal:
 *   - Print sources, target, diff preview, Haiku body (if any)
 *   - Single-key prompt: [a]pply · [s]kip · [d]ismiss · [q]uit
 *
 * No keystroke library. Uses raw-mode stdin for single-char reads with a
 * line-mode fallback when stdin isn't a TTY (reads one full line).
 */

import { loadStore, saveStore, markStatus } from './propose.js';
import { applyProposal } from './apply.js';

export async function reviewInteractive(opts = {}) {
  const store = loadStore();
  const pending = store.proposals.filter(p => p.status === 'pending');
  if (opts.kind) pending.splice(0, pending.length, ...pending.filter(p => p.kind === opts.kind));
  if (opts.id)   pending.splice(0, pending.length, ...pending.filter(p => p.id === opts.id));

  if (pending.length === 0) {
    process.stdout.write('Nothing to review — no pending proposals.\n');
    return 0;
  }

  process.stdout.write(`\nReviewing ${pending.length} pending proposal(s).\n`);
  process.stdout.write('Keys: [a]pply · [s]kip (leave pending) · [d]ismiss · [q]uit\n\n');

  let applied = 0, skipped = 0, dismissed = 0;
  for (const p of pending) {
    renderProposal(p);
    const action = await promptKey('> ');
    process.stdout.write(`  → ${describe(action)}\n\n`);
    if (action === 'q') break;
    if (action === 'a') {
      const r = applyProposal(p.id, { yes: true });
      if (r.ok) applied++;
      else process.stderr.write(`    apply failed: ${r.reason}\n`);
    } else if (action === 'd') {
      saveStore(markStatus(loadStore(), p.id, 'dismissed'));
      dismissed++;
    } else {
      skipped++;
    }
  }
  process.stdout.write(`\nDone: applied ${applied} · dismissed ${dismissed} · skipped ${skipped}\n`);
  return 0;
}

function renderProposal(p) {
  const bar = '─'.repeat(70);
  process.stdout.write(`${bar}\n${p.id}  [${p.kind}]  confidence ${p.confidence ?? '?'}\n`);
  process.stdout.write(`  reason: ${p.reason}\n`);
  process.stdout.write(`  target: ${p.target}\n`);
  process.stdout.write(`  sources:\n`);
  for (const s of p.sources) process.stdout.write(`    - ${s}\n`);
  if (p.diffPreview) {
    process.stdout.write(`  preview:\n`);
    for (const line of String(p.diffPreview).split('\n').slice(0, 12)) {
      process.stdout.write(`    ${line}\n`);
    }
  }
  if (p.haikuOutput) {
    const keys = Object.keys(p.haikuOutput).slice(0, 5).join(', ');
    process.stdout.write(`  haiku:   ${keys}\n`);
    if (typeof p.haikuOutput.body === 'string') {
      const first = p.haikuOutput.body.split('\n').slice(0, 3).join(' | ');
      process.stdout.write(`           body: ${first.slice(0, 100)}${first.length > 100 ? '…' : ''}\n`);
    }
    if (p.haikuOutput.rationale) {
      process.stdout.write(`           rationale: ${String(p.haikuOutput.rationale).slice(0, 100)}\n`);
    }
  }
}

function describe(action) {
  return action === 'a' ? 'apply'
       : action === 'd' ? 'dismiss'
       : action === 'q' ? 'quit'
       : 'skip';
}

/**
 * Prompt for a single keystroke. Falls back to line-mode when stdin
 * isn't a TTY (test harness, piped input). Maps common synonyms so
 * users who type full words and hit enter still get a sensible match.
 *
 * @param {string} prompt
 * @returns {Promise<'a'|'s'|'d'|'q'>}
 */
function promptKey(prompt) {
  process.stdout.write(prompt);
  const isTty = process.stdin.isTTY && typeof process.stdin.setRawMode === 'function';
  if (isTty) {
    return new Promise((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', (buf) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        const ch = buf.toString('utf8').toLowerCase();
        if (ch === '\u0003') { process.exit(130); } // Ctrl-C
        process.stdout.write(ch.replace(/[\r\n]/g, '') + '\n');
        resolve(mapKey(ch[0]));
      });
    });
  }
  // Fallback line mode.
  return new Promise((resolve) => {
    let buf = '';
    const onData = (d) => { buf += d.toString('utf8'); if (buf.includes('\n')) { process.stdin.off('data', onData); resolve(mapKey(buf.trim()[0] ?? 's')); } };
    process.stdin.on('data', onData);
  });
}

function mapKey(ch) {
  if (!ch) return 's';
  const c = ch.toLowerCase();
  if (c === 'a' || c === 'y') return 'a';
  if (c === 'd' || c === 'n') return 'd';
  if (c === 'q') return 'q';
  return 's';
}
