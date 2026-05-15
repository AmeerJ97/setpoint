import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { getClaudeConfigDir } from './paths.js';

const HOME = homedir();
const OWNED_LAUNCHER_MARKER = 'claude-ops launcher (owned by claude-ops)';

export function getBinDir(env = process.env, home = HOME) {
  return expandHome(env.CLAUDE_OPS_BIN_DIR?.trim(), home) || join(home, '.local', 'bin');
}

export function getDefaultInstallRoot(env = process.env, home = HOME) {
  return expandHome(env.CLAUDE_OPS_INSTALL_DIR?.trim(), home) || join(home, '.local', 'share', 'claude-ops');
}

export function parseOwnedLauncherEntry(content) {
  if (typeof content !== 'string' || !content.includes(OWNED_LAUNCHER_MARKER)) return null;
  const match = content.match(/CLAUDE_OPS_ENTRY=['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

export function extractCliEntry(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/(?:^|\s)(?:node\s+)?((?:\/|~\/)[^\s'"]*src\/cli\/index\.js)(?:\s|$)/);
  if (!match) return null;
  return expandHome(match[1]) ?? match[1];
}

export function rootFromCliEntry(entry) {
  const suffix = join('src', 'cli', 'index.js');
  return entry?.endsWith(suffix) ? entry.slice(0, -suffix.length - 1) : null;
}

export function isManagedInstallRoot(root, { currentRepoRoot = null } = {}) {
  if (!root || !existsSync(root)) return false;
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'src', 'cli', 'index.js'))) return false;
  if (currentRepoRoot && sameRealPath(root, currentRepoRoot)) return false;
  if (existsSync(join(root, '.git'))) return false;
  return true;
}

export function inspectOwnedLauncherInstall({ env = process.env, currentRepoRoot = null } = {}) {
  const path = join(getBinDir(env), 'claude-ops');
  if (!existsSync(path)) return { path, entry: null, root: null, source: 'missing' };
  try {
    if (lstatSync(path).isSymbolicLink()) return { path, entry: null, root: null, source: 'symlink' };
    const entry = parseOwnedLauncherEntry(readFileSync(path, 'utf8'));
    const root = entry ? rootFromCliEntry(entry) : null;
    return {
      path,
      entry,
      root: isManagedInstallRoot(root, { currentRepoRoot }) ? root : null,
      source: entry ? 'owned-launcher' : 'file',
    };
  } catch {
    return { path, entry: null, root: null, source: 'unreadable' };
  }
}

export function inspectStatusLineInstall({ settingsPath, currentRepoRoot = null } = {}) {
  const path = settingsPath ?? join(getClaudeConfigDir(), 'settings.json');
  const settings = readJson(path) ?? {};
  const command = settings?.statusLine?.command ?? null;
  const entry = extractCliEntry(command);
  const root = entry ? rootFromCliEntry(entry) : null;
  return {
    settingsPath: path,
    command,
    entry,
    root: isManagedInstallRoot(root, { currentRepoRoot }) ? root : null,
    source: entry ? 'statusline-install' : 'missing',
  };
}

export function resolveInstallTarget({ env = process.env, settingsPath, currentRepoRoot = null } = {}) {
  if (env.CLAUDE_OPS_INSTALL_DIR?.trim()) {
    return { root: getDefaultInstallRoot(env), source: 'explicit-env' };
  }

  const launcher = inspectOwnedLauncherInstall({ env, currentRepoRoot });
  if (launcher.root) return { root: launcher.root, source: 'owned-launcher' };

  const statusLine = inspectStatusLineInstall({ settingsPath, currentRepoRoot });
  if (statusLine.root) return { root: statusLine.root, source: 'statusline-install' };

  return { root: getDefaultInstallRoot(env), source: 'default' };
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function expandHome(value, home = HOME) {
  if (!value) return null;
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

function sameRealPath(a, b) {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return false; }
}
