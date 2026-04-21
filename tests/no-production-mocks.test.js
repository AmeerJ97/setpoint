/**
 * Guard against production-path mocks.
 *
 * Production source (anything under `src/` except known demo surfaces and
 * colocated `*.test.js`) must not contain mock constants, fake data, or
 * "wire this up later" placeholders. Tests, demo renderers, and MITM tests
 * are allowlisted explicitly below.
 *
 * This test is the CI gate — if someone adds `MOCK_FOO = ...` or
 * `if (MOCK) { ... }` to a production path, the build fails before merge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');

// Files/paths whose purpose IS to showcase sample data or to test the
// mock-detection patterns themselves. Everything else under `src/` is
// production and must be clean.
const ALLOWLIST = new Set([
  'src/cli/demo.js',                      // demo HUD renderer with sample ctx
  'tests/no-production-mocks.test.js',    // this file — contains the patterns
]);

// Rust guard sources included — they're production too.
const SCAN_ROOTS = ['src'];

const MOCK_PATTERNS = [
  /\bMOCK_[A-Z0-9_]+/,
  /\bFAKE_[A-Z0-9_]+/,
  /\bDUMMY_[A-Z0-9_]+/,
  /\bPLACEHOLDER_[A-Z0-9_]+/,
  /TODO:\s*wire/i,
  /TODO:\s*mock/i,
  /mock\s+until/i,
  /wire\s+to\s+real/i,
  /\bif\s+MOCK\b/,
  /\bif\s*\(\s*MOCK\s*[)=]/,
];

const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.rs']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'target' || entry === '.git') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXTS.has(full.slice(full.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

function isAllowlisted(relPath) {
  if (ALLOWLIST.has(relPath)) return true;
  // Colocated unit tests are not production source.
  if (relPath.endsWith('.test.js')) return true;
  return false;
}

test('no production-path mocks in src/', () => {
  const offenders = [];
  for (const root of SCAN_ROOTS) {
    const base = join(repoRoot, root);
    for (const abs of walk(base)) {
      const rel = relative(repoRoot, abs).replace(/\\/g, '/');
      if (isAllowlisted(rel)) continue;
      const text = readFileSync(abs, 'utf8');
      for (const pat of MOCK_PATTERNS) {
        const m = text.match(pat);
        if (m) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line}  ${m[0]}`);
          break;
        }
      }
    }
  }
  assert.equal(
    offenders.length, 0,
    `Found mock/placeholder patterns in production code:\n  ${offenders.join('\n  ')}\n` +
    `Mocks are forbidden outside tests and the demo renderer. ` +
    `If a real integration can't be completed yet, surface the blocker — ` +
    `do not insert a mock as "temporary".`
  );
});
