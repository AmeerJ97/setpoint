import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOXES = [];
const ORIGINAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;

afterEach(() => {
  if (ORIGINAL_CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CLAUDE_CONFIG_DIR;
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('skills status reports invalid and oversized entries', async () => {
  const s = sandbox();
  const { main } = await import('./skills.js');
  let out = '';
  const original = process.stdout.write;
  process.stdout.write = chunk => { out += String(chunk); return true; };
  try {
    const code = main(['status', '--json']);
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.surface.invalidSkills, 1);
    assert.equal(parsed.surface.oversizedSkills, 1);
  } finally {
    process.stdout.write = original;
  }
});

test('skills quarantine moves invalid entries and restore brings them back', async () => {
  const s = sandbox();
  const { main } = await import('./skills.js');
  assert.equal(main(['quarantine', '--invalid-only', '--apply', '--json']), 0);
  assert.equal(exists(join(s.skillsRoot, 'bad')), false);
  assert.equal(exists(join(s.quarantineRoot, 'bad')), true);
  assert.equal(main(['restore', 'bad', '--json']), 0);
  assert.equal(exists(join(s.skillsRoot, 'bad')), true);
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-skills-cli-'));
  SANDBOXES.push(dir);
  const claudeDir = join(dir, '.claude');
  const skillsRoot = join(claudeDir, 'skills');
  const quarantineRoot = join(claudeDir, 'skills.quarantine');
  mkdirSync(skillsRoot, { recursive: true });
  writeSkill(skillsRoot, 'good', '---\nname: good\ndescription: ok\n---\nbody\n');
  writeSkill(skillsRoot, 'bad', 'body only\n');
  writeSkill(skillsRoot, 'huge', `---\nname: huge\ndescription: x\n---\n${'line\n'.repeat(700)}`);
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  return { dir, claudeDir, skillsRoot, quarantineRoot };
}

function writeSkill(root, name, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}

function exists(path) {
  return existsSync(path);
}
