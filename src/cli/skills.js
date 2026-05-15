#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaudeConfigDir } from '../data/paths.js';
import { inspectSkillSurface } from '../data/skill-surface.js';

export function main(argv = process.argv.slice(2)) {
  const [sub = 'status', ...rest] = argv;
  const json = rest.includes('--json');
  let result;
  switch (sub) {
    case 'status':
      result = statusResult();
      break;
    case 'quarantine':
      result = quarantineResult(rest);
      break;
    case 'restore':
      result = restoreResult(rest);
      break;
    default:
      result = { ok: false, error: `unknown skills command: ${sub}` };
  }
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : renderSkillsResult(sub, result));
  return result.ok ? 0 : 1;
}

function statusResult() {
  return { ok: true, surface: inspectSkillSurface(skillRoot()), quarantine: readManifest() };
}

function quarantineResult(argv) {
  const apply = argv.includes('--apply');
  const invalidOnly = argv.includes('--invalid-only');
  const oversizedOnly = argv.includes('--oversized-only');
  const maxTokens = readNumberArg(argv, '--max-tokens');
  const report = inspectSkillSurface(skillRoot());
  const selected = report.entries.filter(entry => {
    if (invalidOnly && entry.valid) return false;
    if (oversizedOnly && !entry.oversized) return false;
    if (!invalidOnly && !oversizedOnly && entry.valid && !entry.oversized) return false;
    if (Number.isFinite(maxTokens) && entry.tokens < maxTokens) return false;
    return true;
  });
  if (!apply) return { ok: true, applied: false, selected, count: selected.length, surface: report };

  mkdirSync(quarantineRoot(), { recursive: true });
  const manifest = readManifest();
  for (const entry of selected) {
    const src = join(skillRoot(), entry.name);
    const dst = join(quarantineRoot(), entry.name);
    if (!existsSync(src) || existsSync(dst)) continue;
    renameSync(src, dst);
    manifest.entries.push({ name: entry.name, reason: entry.reason ?? (entry.valid ? 'oversized' : 'invalid') });
  }
  writeManifest(manifest);
  return { ok: true, applied: true, selected, count: selected.length, surface: inspectSkillSurface(skillRoot()), quarantine: manifest };
}

function restoreResult(argv) {
  const all = argv.includes('--all');
  const targets = argv.filter(arg => !arg.startsWith('--'));
  const names = all ? readManifest().entries.map(entry => entry.name) : targets;
  mkdirSync(skillRoot(), { recursive: true });
  const manifest = readManifest();
  const restored = [];
  for (const name of names) {
    const src = join(quarantineRoot(), name);
    const dst = join(skillRoot(), name);
    if (!existsSync(src) || existsSync(dst)) continue;
    renameSync(src, dst);
    restored.push(name);
  }
  manifest.entries = manifest.entries.filter(entry => !restored.includes(entry.name));
  writeManifest(manifest);
  return { ok: true, restored, count: restored.length, surface: inspectSkillSurface(skillRoot()), quarantine: manifest };
}

function readManifest() {
  if (!existsSync(manifestPath())) return { entries: [] };
  try { return JSON.parse(readFileSync(manifestPath(), 'utf8')); }
  catch { return { entries: [] }; }
}

function writeManifest(manifest) {
  mkdirSync(dirname(manifestPath()), { recursive: true });
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}

function readNumberArg(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const parsed = Number(argv[idx + 1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function renderSkillsResult(sub, result) {
  if (!result.ok) return `claude-ops skills: ${result.error}\n`;
  if (sub === 'status') {
    const s = result.surface;
    return `claude-ops skills: ${s.totalSkills} total, ${s.invalidSkills} invalid, ${s.oversizedSkills} oversized, ~${fmtTokens(s.corpusTokens)} corpus, quarantine ${result.quarantine.entries.length}\n`;
  }
  if (sub === 'quarantine') {
    return `claude-ops skills quarantine: ${result.count} selected${result.applied ? ' and moved' : ''}\n`;
  }
  return `claude-ops skills restore: ${result.count} restored\n`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n)) return '--';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

function skillRoot() {
  return join(getClaudeConfigDir(), 'skills');
}

function quarantineRoot() {
  return join(getClaudeConfigDir(), 'skills.quarantine');
}

function manifestPath() {
  return join(quarantineRoot(), 'manifest.json');
}

const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main(process.argv.slice(2)));
}
