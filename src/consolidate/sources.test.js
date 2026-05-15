import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerate, countByKind } from './sources.js';

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'claude-ops-src-'));
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'commands'),        { recursive: true });
  mkdirSync(join(root, 'agents'),          { recursive: true });
  mkdirSync(join(root, 'projects', 'p1', 'memory'), { recursive: true });
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\nkind: fsm\ntrigger:\n  x_min: 1\n---\nalpha body');
  writeFileSync(join(root, 'commands', 'foo.md'),          '# foo command');
  writeFileSync(join(root, 'agents', 'bar.md'),            '# bar agent');
  writeFileSync(join(root, 'projects', 'p1', 'memory', 'n.md'), '# memory');
  writeFileSync(join(root, 'MEMORY.md'),                   'global memory');
  return root;
}

test('enumerate returns all kinds by default', () => {
  const root = scaffold();
  try {
    const arts = enumerate({
      roots: {
        skills: join(root, 'skills'),
        commands: join(root, 'commands'),
        agents: join(root, 'agents'),
        memoryGlobal: join(root, 'MEMORY.md'),
        projectsDir: join(root, 'projects'),
      },
    });
    const kinds = countByKind(arts);
    assert.equal(kinds.skill, 1);
    assert.equal(kinds.command, 1);
    assert.equal(kinds.agent, 1);
    assert.equal(kinds.memory_global, 1);
    assert.equal(kinds.memory_project, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enumerate --include filter drops unrequested kinds', () => {
  const root = scaffold();
  try {
    const arts = enumerate({
      kinds: ['commands', 'agents'],
      roots: {
        skills: join(root, 'skills'),
        commands: join(root, 'commands'),
        agents: join(root, 'agents'),
        memoryGlobal: join(root, 'MEMORY.md'),
        projectsDir: join(root, 'projects'),
      },
    });
    const kinds = countByKind(arts);
    assert.equal(kinds.skill, 0);
    assert.equal(kinds.memory_global, 0);
    assert.equal(kinds.command + kinds.agent, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('enumerate excludes by substring', () => {
  const root = scaffold();
  try {
    const arts = enumerate({
      excludes: ['foo'],
      roots: {
        skills: join(root, 'skills'),
        commands: join(root, 'commands'),
        agents: join(root, 'agents'),
        memoryGlobal: join(root, 'MEMORY.md'),
        projectsDir: join(root, 'projects'),
      },
    });
    assert.equal(arts.filter(a => a.path.includes('foo')).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('frontmatter parsed when present', () => {
  const root = scaffold();
  try {
    const arts = enumerate({
      kinds: ['skills'],
      roots: {
        skills: join(root, 'skills'),
        commands: join(root, 'commands'),
        agents: join(root, 'agents'),
        memoryGlobal: join(root, 'MEMORY.md'),
        projectsDir: join(root, 'projects'),
      },
    });
    assert.equal(arts.length, 1);
    assert.equal(arts[0].frontmatter?.name, 'alpha');
    assert.equal(arts[0].frontmatter?.kind, 'fsm');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
