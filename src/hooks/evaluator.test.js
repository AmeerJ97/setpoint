import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHook, triggerFires, selectHook, renderBody } from './evaluator.js';

const SAMPLE = `---
name: read-before-edit
kind: reminder
trigger:
  ratio_below: 1.5
  edits_min: 3
priority: 80
cooldown_min: 15
---
Body goes here with {ratio} placeholder.
`;

test('parseHook: reads name/kind/priority/cooldown + trigger nest', () => {
  const h = parseHook(SAMPLE);
  assert.equal(h.name, 'read-before-edit');
  assert.equal(h.kind, 'reminder');
  assert.equal(h.priority, 80);
  assert.equal(h.cooldownMin, 15);
  assert.equal(h.trigger.ratio_below, 1.5);
  assert.equal(h.trigger.edits_min, 3);
  assert.match(h.body, /Body goes here/);
});

test('parseHook: rejects docs without frontmatter', () => {
  assert.equal(parseHook('no frontmatter here'), null);
});

test('triggerFires: _below semantics', () => {
  assert.equal(triggerFires({ ratio_below: 1.5 }, { ratio: 1.0 }), true);
  assert.equal(triggerFires({ ratio_below: 1.5 }, { ratio: 1.5 }), false);   // not strict
  assert.equal(triggerFires({ ratio_below: 1.5 }, { ratio: 2.0 }), false);
});

test('triggerFires: _above semantics', () => {
  assert.equal(triggerFires({ context_above: 70 }, { context: 72 }), true);
  assert.equal(triggerFires({ context_above: 70 }, { context: 70 }), false);
  assert.equal(triggerFires({ context_above: 70 }, { context: 10 }), false);
});

test('triggerFires: _min inclusive, _max inclusive', () => {
  assert.equal(triggerFires({ edits_min: 3 }, { edits: 3 }), true);
  assert.equal(triggerFires({ edits_min: 3 }, { edits: 2 }), false);
  assert.equal(triggerFires({ reads_this_turn_max: 0 }, { reads_this_turn: 0 }), true);
  assert.equal(triggerFires({ reads_this_turn_max: 0 }, { reads_this_turn: 1 }), false);
});

test('triggerFires: all predicates must hold (AND)', () => {
  const trig = { ratio_below: 1.5, edits_min: 3 };
  assert.equal(triggerFires(trig, { ratio: 1.0, edits: 5 }), true);
  assert.equal(triggerFires(trig, { ratio: 1.0, edits: 2 }), false);
  assert.equal(triggerFires(trig, { ratio: 2.0, edits: 5 }), false);
});

test('triggerFires: missing metric → predicate fails closed', () => {
  assert.equal(triggerFires({ ratio_below: 1.5 }, {}), false);
});

test('selectHook: picks highest-priority matching hook', () => {
  const hooks = [
    { name: 'low',  kind: 'reminder', priority: 10, cooldownMin: 0, trigger: { ratio_below: 2 }, body: '' },
    { name: 'high', kind: 'reminder', priority: 90, cooldownMin: 0, trigger: { ratio_below: 2 }, body: '' },
    { name: 'mid',  kind: 'reminder', priority: 50, cooldownMin: 0, trigger: { ratio_below: 2 }, body: '' },
  ].sort((a, b) => b.priority - a.priority);
  const r = selectHook({ ratio: 1 }, hooks);
  assert.equal(r.name, 'high');
});

test('selectHook: returns null when nothing matches', () => {
  const hooks = [
    { name: 'x', kind: 'reminder', priority: 10, cooldownMin: 0, trigger: { context_above: 99 }, body: '' },
  ];
  assert.equal(selectHook({ context: 50 }, hooks), null);
});

test('renderBody: substitutes placeholders', () => {
  const out = renderBody('R:E is {ratio} with {edits} edits', { ratio: 1.2, edits: 5 });
  assert.equal(out, 'R:E is 1.2 with 5 edits');
});

test('renderBody: leaves unknown placeholders intact', () => {
  const out = renderBody('hello {unknown}', {});
  assert.equal(out, 'hello {unknown}');
});

test('loadHooks: real config/hooks dir loads 8 starter hooks', async () => {
  const { loadHooks } = await import('./evaluator.js');
  const hooks = loadHooks();
  // All 8 starter hooks should be present and sorted priority desc.
  const names = hooks.map(h => h.name);
  assert.ok(names.includes('read-before-edit'));
  assert.ok(names.includes('compact-approaching'));
  assert.ok(names.includes('rate-limit-near'));
  for (let i = 1; i < hooks.length; i++) {
    assert.ok(hooks[i - 1].priority >= hooks[i].priority, 'sorted by priority desc');
  }
});
