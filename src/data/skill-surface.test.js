import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSkillSurface } from './skill-surface.js';

const SANDBOXES = [];

test.afterEach(() => {
  while (SANDBOXES.length) rmSync(SANDBOXES.pop(), { recursive: true, force: true });
});

test('inspectSkillSurface flags missing frontmatter and large corpus', () => {
  const dir = sandbox();
  writeSkill(dir, 'good', '---\nname: good\ndescription: ok\n---\nbody\n');
  writeSkill(dir, 'bad', 'body only\n');
  writeSkill(dir, 'huge', `---\nname: huge\ndescription: x\n---\n${'line\n'.repeat(600)}`);
  const report = inspectSkillSurface(dir);
  assert.equal(report.totalSkills, 3);
  assert.equal(report.invalidSkills, 1);
  assert.equal(report.oversizedSkills, 1);
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-skill-surface-'));
  SANDBOXES.push(dir);
  return dir;
}

function writeSkill(root, name, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body);
}
