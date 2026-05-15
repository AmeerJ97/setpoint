#!/usr/bin/env node
/**
 * `claude-ops doctor` — read-only install/runtime diagnostics.
 */

import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { detectRuntimeMode } from '../data/mode.js';
import { getClaudeConfigDir } from '../data/paths.js';
import { getProviderAdapter } from '../data/provider-adapters.js';
import { getExperimentalDefaults } from '../data/defaults.js';
import { readJson as readJsonFile, readJsonlWindow } from '../data/jsonl.js';
import {
  extractCliEntry,
  getBinDir as getInstallBinDir,
  parseOwnedLauncherEntry,
  resolveInstallTarget,
  rootFromCliEntry,
} from '../data/install-target.js';
import { inspectPromptCacheConfig, resolveConfiguredModel, contextWindowForModel } from '../data/prompt-cache.js';
import { inspectSkillSurface } from '../data/skill-surface.js';
import { estimateAgentsTokens, estimateMemoryTokens, estimateMcpTokens, readLatestInputTokens } from '../context/buckets.js';
import { findActiveSessions, findLatestSessionJsonl, findSessionJsonl } from '../data/session.js';
import { computeApiWindowRefs } from '../analytics/api-cost.js';
import { computeVertexTelemetry } from '../analytics/vertex-telemetry.js';
import { inspectGuardControl } from '../guard/mode-control.js';
import { collectGuardValidationState } from '../guard/guard-validation.js';
import { collectVertexConfigState } from '../guard/vertex-config.js';
import { readDiscoveryCache, resolveLocations, VERTEX_DISCOVERY_FILE } from '../vertex/discovery.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.js');
export const HOOK_EMITTER = join(REPO_ROOT, 'src', 'hooks', 'emit.js');
export const BASH_GUARD_ENTRY = join(REPO_ROOT, 'src', 'guard', 'claude-ops-guard.sh');
export const RUST_GUARD_ENTRY = join(REPO_ROOT, 'src', 'guard', 'rust', 'target', 'release', 'claude-ops-guard');

export const CORE_UNITS = [
  {
    name: 'claude-ops-analytics.service',
    template: join(REPO_ROOT, 'config', 'analytics-daemon.service'),
    expected: join(REPO_ROOT, 'src', 'analytics', 'daemon.js'),
    kind: 'service',
  },
  {
    name: 'claude-ops-health.service',
    template: join(REPO_ROOT, 'config', 'health-auditor.service'),
    expected: join(REPO_ROOT, 'src', 'health', 'index.js'),
    kind: 'service',
  },
  {
    name: 'claude-ops-health.timer',
    template: join(REPO_ROOT, 'config', 'health-auditor.timer'),
    expected: null,
    kind: 'timer',
  },
  {
    name: 'claude-ops-advisor.service',
    template: join(REPO_ROOT, 'config', 'daily-advisor.service'),
    expected: join(REPO_ROOT, 'src', 'advisor', 'index.js'),
    kind: 'service',
  },
  {
    name: 'claude-ops-advisor.timer',
    template: join(REPO_ROOT, 'config', 'daily-advisor.timer'),
    expected: null,
    kind: 'timer',
  },
  {
    name: 'claude-ops-guard.service',
    template: join(REPO_ROOT, 'config', 'claude-ops-guard.service'),
    expected: BASH_GUARD_ENTRY,
    expectedAny: [BASH_GUARD_ENTRY, RUST_GUARD_ENTRY],
    kind: 'service',
    auditOnly: true,
  },
];

export const LEGACY_UNITS = [
  'claude-hud-analytics.service',
  'claude-hud-health.service',
  'claude-hud-health.timer',
  'claude-hud-advisor.service',
  'claude-hud-advisor.timer',
  'claude-quality-guard.service',
];

export function getSystemdUserDir(env = process.env) {
  return env.CLAUDE_OPS_SYSTEMD_USER_DIR || join(homedir(), '.config', 'systemd', 'user');
}

export function getBinDir(env = process.env) {
  return getInstallBinDir(env);
}

export async function main(args = process.argv.slice(2), options = {}) {
  const json = args.includes('--json');
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return 0;
  }

  const stdinPayload = options.stdinPayload ?? await readOptionalJsonStdin();
  const report = buildDoctorReport({
    stdinPayload,
    env: options.env ?? process.env,
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderDoctorReport(report));
  }

  return report.ok ? 0 : 1;
}

export function buildDoctorReport({ stdinPayload = null, env = process.env } = {}) {
  const settingsPath = join(getClaudeConfigDir(), 'settings.json');
  const settings = readJson(settingsPath) ?? {};
  const mergedEnv = { ...env, ...(settings.env ?? {}) };
  const installTarget = resolveInstallTarget({ env, settingsPath, currentRepoRoot: REPO_ROOT });
  const apiKeyHelper = Boolean(settings.apiKeyHelper);
  const runtimeMode = detectRuntimeMode(stdinPayload, stdinPayload ? env : mergedEnv, { apiKeyHelper });
  const promptCache = inspectPromptCacheConfig(settings, mergedEnv);
  const skillSurface = inspectSkillSurface();
  const contextSurface = inspectContextSurface(settings, mergedEnv);
  const history = readJsonlWindow(join(getClaudeConfigDir(), 'plugins', 'claude-ops', 'usage-history.jsonl'), 30 * 86_400_000);
  const vertexApiMaxSnapshotAgeMinutes = Number.isFinite(Number(env.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES))
    ? Number(env.CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES)
    : undefined;
  const activeModel = resolveConfiguredModel(settings, mergedEnv);
  const vertexTelemetry = runtimeMode.backend === 'vertex-ai'
    ? computeVertexTelemetry(null, history, {
        vertexApiFile: env.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE,
        vertexApiMaxSnapshotAgeMinutes,
        env,
        vertexContext: {
          projectId: mergedEnv.ANTHROPIC_VERTEX_PROJECT_ID ?? mergedEnv.GOOGLE_CLOUD_PROJECT ?? mergedEnv.GCLOUD_PROJECT ?? null,
          region: mergedEnv.CLOUD_ML_REGION ?? null,
          model: activeModel,
          endpoint: mergedEnv.ANTHROPIC_VERTEX_BASE_URL ?? null,
        },
      })
    : null;
  const runtimeModeResolved = runtimeMode.backend === 'vertex-ai' && vertexTelemetry?.telemetryAuthority
    ? { ...runtimeMode, telemetryAuthority: vertexTelemetry.telemetryAuthority }
    : runtimeMode;
  const providerAdapter = getProviderAdapter(runtimeModeResolved.authProvider);
  const statusLine = inspectStatusLine(settings);
  const hooks = inspectHooks(settings);
  const cli = inspectCli(env);
  const services = inspectServices(env);
  const legacyUnits = inspectLegacyUnits(env);
  const guard = inspectGuard(env);
  const guardValidation = collectGuardValidationState(mergedEnv, { settingsPath });
  const vertexConfig = collectVertexConfigState(mergedEnv, { settingsPath });
  const vertexDiscovery = inspectVertexDiscovery(settings, env);
  const analyticsRuntime = inspectAnalyticsRuntime(env);
  const health = inspectHealth();
  const dataMaturity = inspectDataMaturity(runtimeModeResolved, history, vertexTelemetry);
  const experimentalTools = inspectExperimentalTools(env);
  const vertexApiCostAudit = inspectVertexApiCostAudit(runtimeModeResolved, vertexTelemetry);
  const vertexApiStalenessPolicy = inspectVertexApiStalenessPolicy(runtimeModeResolved, vertexApiMaxSnapshotAgeMinutes);
  const claudeVersion = readCommandVersion('claude', ['--version']);

  const checks = [
    check('cli-launcher', cli.ok, cli.path || 'claude-ops not found on PATH'),
    check('statusLine', statusLine.ok, statusLine.command || 'not configured'),
    check('hook-contract', hooks.outputContractOk, hooks.installed ? 'current output contract' : 'hook not installed'),
    check('core-services', services.every(s => s.ok), services.filter(s => !s.ok).map(s => s.name).join(', ') || 'all installed paths current'),
    check('analytics-runtime', true, analyticsRuntime.detail),
    check('legacy-units', legacyUnits.every(s => !s.installed), legacyUnits.filter(s => s.installed).map(s => s.name).join(', ') || 'no old unit files'),
    check('guard-audit-only', guard.auditOnly, guard.detail),
    check(
      'guard-controls',
      guardValidation.summary.controls.drift === 0,
      guardValidation.summary.controls.drift === 0
        ? 'official guard controls held'
        : `${guardValidation.summary.controls.drift} official docs-backed controls drift`,
    ),
    check('vertex-config', !vertexConfig.apiTelemetryBypass, vertexConfig.detail),
    check(
      'vertex-discovery',
      runtimeMode.backend !== 'vertex-ai' || vertexDiscovery.available,
      runtimeMode.backend !== 'vertex-ai'
        ? 'not-vertex'
        : (vertexDiscovery.available
          ? `${vertexDiscovery.modelCount} cached discovered models`
          : 'no Vertex discovery cache yet; run claude-ops vertex discover --refresh'),
    ),
    check(
      'vertex-cache-policy',
      runtimeMode.backend !== 'vertex-ai'
        || promptCache.mode === 'off'
        || promptCache.mode === '1h'
        || contextSurface.staticPrefixTokens < 30_000
        || !promptCache.supports1h,
      runtimeMode.backend !== 'vertex-ai'
        ? 'not-vertex'
        : (promptCache.mode === 'off'
          ? `prompt caching disabled for ${promptCache.activeModelId ?? 'Vertex model'}`
          : (promptCache.mode === '1h'
            ? `prompt cache ${promptCache.mode} for ${promptCache.activeModelId ?? 'Vertex model'}`
            : `prompt cache 5m default with ~${fmtInt(contextSurface.staticPrefixTokens)} static-prefix tokens; consider claude-ops vertex cache 1h`)),
    ),
    check(
      'skills-surface',
      !skillSurface.corpusLarge && skillSurface.invalidSkills === 0 && skillSurface.oversizedSkills === 0,
      skillSurface.invalidSkills > 0 || skillSurface.oversizedSkills > 0
        ? `${skillSurface.invalidSkills} invalid and ${skillSurface.oversizedSkills} oversized skills under ${skillSurface.root}`
        : `${skillSurface.totalSkills} skills, ~${fmtInt(skillSurface.corpusTokens)} corpus tokens under ${skillSurface.root}`,
    ),
    check(
      'session-context',
      !contextSurface.alert,
      contextSurface.detail,
    ),
    check('vertex-api-staleness-policy', vertexApiStalenessPolicy.ok, vertexApiStalenessPolicy.detail),
    check('guard-thinking-skip', guard.thinkingSkip, guard.thinkingSkipReason || 'thinking skip reason missing'),
    check(
      'vertex-api-telemetry',
      runtimeModeResolved.backend !== "vertex-ai" || runtimeModeResolved.telemetryAuthority === "vertex-api",
      runtimeModeResolved.backend !== "vertex-ai"
        ? "not-vertex"
        : (runtimeModeResolved.telemetryAuthority === "vertex-api"
          ? ("authoritative snapshot " + (vertexTelemetry?.retrievedAt ?? "present"))
          : (vertexTelemetry?.apiTelemetryReason
            ?? ("telemetry authority " + runtimeModeResolved.telemetryAuthority + "; authoritative Vertex API snapshot required"))),
    ),
    check('vertex-api-cost-consistency', vertexApiCostAudit.ok, vertexApiCostAudit.detail),
    check('telemetry-maturity', dataMaturity.state !== 'cold_start', dataMaturity.reason),
    check('experimental-tools', true, `scan:${experimentalTools.scan.enabled ? 'enabled' : 'gated'} consolidate:${experimentalTools.consolidate.enabled ? 'enabled' : 'gated'}`),
  ];

  const report = {
    ok: checks.filter(c => !['telemetry-maturity', 'guard-controls', 'vertex-discovery', 'vertex-cache-policy', 'skills-surface', 'session-context', 'vertex-api-telemetry', 'vertex-api-cost-consistency'].includes(c.name)).every(c => c.status === 'ok'),
    repoRoot: REPO_ROOT,
    claudeVersion,
    installTarget,
    runtimeMode: runtimeModeResolved,
    promptCache,
    skillSurface,
    contextSurface,
    providerAdapter,
    authSignals: {
      ANTHROPIC_API_KEY: hasEnv(mergedEnv, 'ANTHROPIC_API_KEY'),
      ANTHROPIC_AUTH_TOKEN: hasEnv(mergedEnv, 'ANTHROPIC_AUTH_TOKEN'),
      ANTHROPIC_BASE_URL: hasEnv(mergedEnv, 'ANTHROPIC_BASE_URL'),
      CLAUDE_CODE_USE_BEDROCK: truthy(mergedEnv.CLAUDE_CODE_USE_BEDROCK),
      CLAUDE_CODE_USE_VERTEX: truthy(mergedEnv.CLAUDE_CODE_USE_VERTEX),
      CLAUDE_CODE_USE_FOUNDRY: truthy(mergedEnv.CLAUDE_CODE_USE_FOUNDRY),
      apiKeyHelper,
    },
    cli,
    statusLine,
    hooks,
    services,
    legacyUnits,
    guard,
    guardValidation,
    vertexConfig,
    vertexDiscovery,
    vertexTelemetry,
    analyticsRuntime,
    health,
    dataMaturity,
    experimentalTools,
    checks,
  };

  return {
    ...report,
    fixPlan: buildFixPlan(report),
  };
}

export function inspectStatusLine(settings) {
  const expected = `node ${CLI_ENTRY}`;
  const command = settings?.statusLine?.command ?? null;
  const installedEntry = command ? extractCliEntry(command) : null;
  const installedRoot = installedEntry ? rootFromCliEntry(installedEntry) : null;
  const installedElsewhere = Boolean(installedEntry && installedEntry !== CLI_ENTRY && existsSync(installedEntry));
  return {
    configured: Boolean(command),
    command,
    expected,
    installedEntry,
    installedRoot,
    installedElsewhere,
    ok: command === expected
      || command === CLI_ENTRY
      || (typeof command === 'string' && command.includes(CLI_ENTRY))
      || installedElsewhere,
  };
}

export function inspectHooks(settings) {
  const hooks = settings?.hooks?.UserPromptSubmit;
  const installed = JSON.stringify(hooks ?? '').includes(HOOK_EMITTER);
  const outputContractOk = safeRead(HOOK_EMITTER).includes('hookSpecificOutput')
    && safeRead(HOOK_EMITTER).includes('additionalContext');
  return {
    installed,
    outputContract: 'hookSpecificOutput.additionalContext',
    outputContractOk,
  };
}

export function inspectCli(env = process.env) {
  const expected = CLI_ENTRY;
  const explicitPath = join(getBinDir(env), 'claude-ops');
  const found = existsSync(explicitPath)
    ? { status: 0, stdout: explicitPath }
    : spawnSync('which', ['claude-ops'], { encoding: 'utf8', env });
  const path = found.status === 0 ? String(found.stdout).trim() : null;
  let target = null;
  let launcher = false;
  let symlink = false;
  let launcherEntry = null;
  let installedRoot = null;
  let installedElsewhere = false;
  let ok = false;
  if (path) {
    try {
      const stat = lstatSync(path);
      symlink = stat.isSymbolicLink();
      target = symlink ? resolve(dirname(path), readlinkSafe(path)) : path;
      const content = symlink ? '' : safeRead(path);
      launcherEntry = parseOwnedLauncherEntry(content);
      installedRoot = launcherEntry ? rootFromCliEntry(launcherEntry) : null;
      installedElsewhere = Boolean(launcherEntry && launcherEntry !== expected && existsSync(launcherEntry));
      launcher = launcherEntry === expected || installedElsewhere;
      ok = !symlink && (launcher || path === expected);
    } catch { /* path vanished between which and stat */ }
  }
  return { path, expected, target, symlink, launcher, launcherEntry, installedRoot, installedElsewhere, ok };
}

export function inspectServices(env = process.env) {
  const dir = getSystemdUserDir(env);
  return CORE_UNITS.map(unit => {
    const path = join(dir, unit.name);
    const content = safeRead(path);
    const installed = Boolean(content);
    const pathCurrent = servicePathCurrent(unit, content);
    return {
      name: unit.name,
      kind: unit.kind,
      path,
      installed,
      pathCurrent,
      ok: installed && pathCurrent,
    };
  });
}

export function servicePathCurrent(unit, content) {
  if (!content) return false;
  const accepted = unit.expectedAny ?? (unit.expected ? [unit.expected] : []);
  if (accepted.length === 0) return true;
  return accepted.some(expected => content.includes(expected) || contentReferencesInstalledCopy(content, expected));
}

function contentReferencesInstalledCopy(content, expected) {
  const rel = relative(REPO_ROOT, expected).split(sep).join('/');
  if (!rel || rel.startsWith('..')) return false;
  if (!content.includes(rel) || !content.includes('claude-ops')) return false;
  const candidates = content.match(/\/[^\s'"]+/g) ?? [];
  return candidates.some(candidate => candidate.endsWith(rel) && existsSync(candidate));
}

export function inspectLegacyUnits(env = process.env) {
  const dir = getSystemdUserDir(env);
  return LEGACY_UNITS.map(name => {
    const path = join(dir, name);
    const content = safeRead(path);
    const installed = Boolean(content);
    return {
      name,
      path,
      installed,
      stalePath: installed && /setpoint|claude-hud|claude-quality-guard/.test(content),
    };
  });
}

export function inspectGuard(env = process.env) {
  return inspectGuardControl(env);
}

export function inspectAnalyticsRuntime(env = process.env) {
  const active = systemctlState('is-active', 'claude-ops-analytics.service', env);
  const enabled = systemctlState('is-enabled', 'claude-ops-analytics.service', env);
  const running = active === 'active';
  const loginStart = enabled === 'enabled';
  return {
    active,
    enabled,
    mode: 'on-demand',
    running,
    loginStart,
    detail: `${running ? 'running' : 'stopped'}; on-demand; ${loginStart ? 'enabled at login' : 'not enabled at login'}; HUD wakes collector`,
  };
}

export function inspectHealth() {
  const report = readJsonFile(join(getClaudeConfigDir(), 'plugins', 'claude-ops', 'health-report.json'));
  if (!report) {
    return { available: false, issueCount: null, generatedAt: null, stale: true };
  }
  const ageMs = Date.now() - Date.parse(report.generatedAt ?? 0);
  return {
    available: true,
    issueCount: report.issueCount ?? 0,
    generatedAt: report.generatedAt ?? null,
    stale: !Number.isFinite(ageMs) || ageMs > 24 * 3600_000,
  };
}

export function inspectDataMaturity(runtimeMode = null, history = null, vertexTelemetry = null) {
  const rows = history ?? readJsonlWindow(join(getClaudeConfigDir(), 'plugins', 'claude-ops', 'usage-history.jsonl'), 30 * 86_400_000);
  if (runtimeMode?.backend === 'vertex-ai') {
    return (vertexTelemetry ?? computeVertexTelemetry(null, rows)).dataMaturity;
  }
  return computeApiWindowRefs({}, null, rows).dataMaturity;
}

export function inspectExperimentalTools(env = process.env) {
  const defaults = getExperimentalDefaults();
  const envEnabled = env.CLAUDE_OPS_EXPERIMENTAL === '1';
  return {
    scan: { enabled: envEnabled || defaults.scan, defaultEnabled: defaults.scan },
    consolidate: { enabled: envEnabled || defaults.consolidate, defaultEnabled: defaults.consolidate },
  };
}

function inspectVertexApiCostAudit(runtimeMode, vertexTelemetry) {
  if (runtimeMode?.backend !== 'vertex-ai') return { ok: true, detail: 'not-vertex' };
  if (runtimeMode?.telemetryAuthority !== 'vertex-api') {
    return { ok: false, detail: 'authoritative Vertex API snapshot required for cost consistency checks' };
  }
  const five = vertexTelemetry?.fiveHour ?? null;
  const seven = vertexTelemetry?.sevenDay ?? null;
  const invalidFive = Number.isFinite(Number(five?.costUsd))
    && (Number(five.costUsd) < 0 || (Number.isFinite(five?.totalTokens) && five.totalTokens > 0 && Number(five.costUsd) <= 0));
  const invalidSeven = Number.isFinite(Number(seven?.costUsd))
    && (Number(seven.costUsd) < 0 || (Number.isFinite(seven?.totalTokens) && seven.totalTokens > 0 && Number(seven.costUsd) <= 0));
  const hasUsageFive = Number.isFinite(Number(five?.totalTokens)) && Number(five.totalTokens) > 0;
  const hasUsageSeven = Number.isFinite(Number(seven?.totalTokens)) && Number(seven.totalTokens) > 0;
  const uninformativeUsage = !hasUsageFive && !hasUsageSeven;
  if (invalidFive || invalidSeven) {
    return { ok: false, detail: 'authoritative Vertex snapshot has nonpositive or negative cost_usd; verify API payload fields' };
  }
  if (uninformativeUsage) {
    return { ok: false, detail: 'authoritative Vertex snapshot reports zero total_tokens across windows; advisory will throttle as non-actionable telemetry' };
  }
  return { ok: true, detail: 'authoritative Vertex API cost fields present' };
}

function inspectVertexApiStalenessPolicy(runtimeMode, vertexApiMaxSnapshotAgeMinutes) {
  if (runtimeMode?.backend !== 'vertex-ai') return { ok: true, detail: 'not-vertex' };
  if (!Number.isFinite(vertexApiMaxSnapshotAgeMinutes)) {
    return { ok: true, detail: 'using default staleness cutoff (20m)' };
  }
  if (vertexApiMaxSnapshotAgeMinutes <= 0) {
    return {
      ok: false,
      detail: 'staleness cutoff disabled (CLAUDE_OPS_VERTEX_API_MAX_AGE_MINUTES<=0); stale Vertex API snapshots can bypass throttle safeguards',
    };
  }
  return { ok: true, detail: 'staleness cutoff ' + Math.floor(vertexApiMaxSnapshotAgeMinutes) + 'm' };
}

export function buildFixPlan(report) {
  const actions = [];
  if (!report.cli.ok) actions.push({ id: 'repair-cli-launcher', command: 'claude-ops repair --apply', reason: 'local claude-ops launcher is missing, stale, or still a symlink' });
  if (!report.statusLine.ok) actions.push({ id: 'repair-statusline', command: 'claude-ops repair --apply', reason: 'Claude Code statusLine does not point at src/cli/index.js' });
  if (report.services.some(s => !s.ok)) actions.push({ id: 'install-current-units', command: 'claude-ops repair --apply', reason: 'current user systemd unit files are missing or stale' });
  if (report.legacyUnits.some(s => s.installed)) actions.push({ id: 'remove-legacy-units', command: 'claude-ops repair --apply', reason: 'legacy claude-hud/setpoint unit files are still installed' });
  if (!report.guard.thinkingSkip) actions.push({ id: 'restore-thinking-skip', command: 'claude-ops repair --apply', reason: 'guard thinking category skip marker is missing' });
  if ((report.guardValidation?.summary?.controls?.drift ?? 0) > 0) actions.push({ id: 'repair-guard-controls', command: 'claude-ops guard repair --apply', reason: 'documented guard controls drift from the Claude Code settings/env contract' });
  if (report.runtimeMode?.backend === 'vertex-ai' && !report.vertexDiscovery?.available) actions.push({ id: 'vertex-discover', command: 'claude-ops vertex discover --refresh', reason: 'no cached Vertex model sweep is available for local switching/setup' });
  if (report.runtimeMode?.backend === 'vertex-ai' && report.promptCache?.mode === '5m' && report.promptCache?.supports1h && report.contextSurface?.staticPrefixTokens >= 30_000) actions.push({ id: 'vertex-cache-1h', command: 'claude-ops vertex cache 1h', reason: 'large static Vertex prefix makes the default 5m cache TTL wasteful' });
  if (report.runtimeMode?.backend === 'vertex-ai' && report.vertexTelemetry?.telemetryAuthority !== 'vertex-api') actions.push({ id: 'vertex-telemetry-collect', command: 'claude-ops telemetry vertex collect --json', reason: 'authoritative Vertex billing snapshot is still missing' });
  if (report.skillSurface?.corpusLarge || report.skillSurface?.invalidSkills > 0 || report.skillSurface?.oversizedSkills > 0) actions.push({ id: 'inspect-skills-surface', command: 'claude-ops skills status --json', reason: 'skills surface is large or malformed enough to distort trivial-session context' });
  return actions;
}

export function renderDoctorReport(report) {
  const lines = [];
  lines.push(`claude-ops doctor: ${report.ok ? 'ok' : 'needs repair'}`);
  lines.push(`repo: ${report.repoRoot}`);
  lines.push(`install target: ${report.installTarget.root} (${report.installTarget.source})`);
  lines.push(`claude: ${report.claudeVersion ?? 'not found'}`);
  lines.push(`mode: ${report.runtimeMode.backendLabel} ${report.runtimeMode.authProvider} / ${report.runtimeMode.billingSignal} / ${report.runtimeMode.telemetryAuthority}`);
  for (const c of report.checks) {
    lines.push(`${c.status === 'ok' ? 'ok' : 'fix'}  ${c.name}: ${c.detail}`);
  }
  if (report.fixPlan.length > 0) {
    lines.push('fix plan:');
    for (const action of report.fixPlan) {
      lines.push(`  - ${action.command}  # ${action.reason}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function check(name, ok, detail) {
  return { name, status: ok ? 'ok' : 'fix', detail };
}

function inspectVertexDiscovery(settings, env) {
  const projectId = settings?.env?.ANTHROPIC_VERTEX_PROJECT_ID ?? env.ANTHROPIC_VERTEX_PROJECT_ID ?? null;
  if (!projectId) return { available: false, path: VERTEX_DISCOVERY_FILE, projectId: null, modelCount: 0, lastUpdated: null, errors: [] };
  const snapshot = readDiscoveryCache(projectId, resolveLocations('common'));
  return {
    available: Boolean(snapshot),
    path: VERTEX_DISCOVERY_FILE,
    projectId,
    modelCount: snapshot?.models?.length ?? 0,
    lastUpdated: snapshot?.last_updated ?? null,
    errors: snapshot?.errors ?? [],
  };
}

function inspectContextSurface(settings, env) {
  const staticPrefixTokens = 15_000 + estimateAgentsTokens(process.cwd()) + estimateMemoryTokens(process.cwd()) + estimateMcpTokens();
  const activeModel = resolveConfiguredModel(settings, env);
  const contextWindow = contextWindowForModel(activeModel);
  const activeSession = resolveActiveSession(process.cwd());
  const latestInputTokens = activeSession?.path ? readLatestInputTokens(activeSession.path) : null;
  const skillSurface = inspectSkillSurface();
  const latestPct = Number.isFinite(latestInputTokens) ? Math.round((latestInputTokens / contextWindow) * 100) : null;
  const alert = skillSurface.corpusLarge || (Number.isFinite(latestInputTokens) && latestInputTokens >= contextWindow * 0.5);
  const detail = Number.isFinite(latestInputTokens)
    ? `latest input ~${fmtInt(latestInputTokens)}/${fmtInt(contextWindow)}; static-prefix floor ~${fmtInt(staticPrefixTokens)}; skills corpus ~${fmtInt(skillSurface.corpusTokens)}`
    : `static-prefix floor ~${fmtInt(staticPrefixTokens)}; skills corpus ~${fmtInt(skillSurface.corpusTokens)}`;
  return {
    activeModel,
    contextWindow,
    staticPrefixTokens,
    latestInputTokens,
    latestPercent: latestPct,
    skillCorpusTokens: skillSurface.corpusTokens,
    alert,
    detail,
  };
}

function resolveActiveSession(cwd) {
  const active = findActiveSessions();
  const matching = active.find(session => session.cwd && cwd.startsWith(session.cwd));
  const chosen = matching ?? active[active.length - 1];
  if (chosen?.sessionId) {
    const found = findSessionJsonl(chosen.sessionId);
    if (found) return { sessionId: chosen.sessionId, path: found.path };
  }
  const latest = findLatestSessionJsonl(cwd);
  return latest ? { sessionId: '(latest)', path: latest.path } : null;
}

function fmtInt(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

async function readOptionalJsonStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = chunks.join('').trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function safeRead(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function readlinkSafe(path) {
  try { return readlinkSync(path); }
  catch { return ''; }
}

function readCommandVersion(command, args) {
  const out = spawnSync(command, args, { encoding: 'utf8' });
  if (out.status !== 0) return null;
  return (out.stdout || out.stderr).trim() || null;
}

function systemctlState(action, unit, env) {
  if (env.CLAUDE_OPS_SKIP_SYSTEMCTL === '1') return 'skipped';
  const r = spawnSync('systemctl', ['--user', action, unit], { encoding: 'utf8', env });
  const text = (r.stdout || r.stderr || '').trim();
  return text || (r.status === 0 ? 'ok' : 'unknown');
}

function hasEnv(env, name) {
  return typeof env[name] === 'string' && env[name].trim().length > 0;
}

function truthy(value) {
  if (typeof value !== 'string') return Boolean(value);
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function printHelp() {
  process.stdout.write(`\
claude-ops doctor [--json]

Read-only diagnostics for statusLine, auth/billing mode, hooks, and services.
Pipe a Claude Code statusLine JSON payload into doctor to classify quota vs cost mode.
`);
}

const argvPath = process.argv[1];
const scriptPath = fileURLToPath(import.meta.url);
if (argvPath && resolve(argvPath) === scriptPath) {
  main().then(code => process.exit(code ?? 0));
}
