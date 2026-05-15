import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowFSM, loadState, saveState } from './fsm-controller.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'claude-ops-fsm-'));
}

test('cold start is SCOUTING with zero thrashing ticks', () => {
  const fsm = new WorkflowFSM();
  assert.equal(fsm.currentState, 'SCOUTING');
  assert.equal(fsm.thrashingTicks, 0);
});

test('SCOUTING → EXECUTING when intent locks and writes start', () => {
  const fsm = new WorkflowFSM();
  const d = fsm.tick({ rwRatio: 1.5, errorDensity: 0, drift: 0.05 });
  assert.equal(d.state, 'EXECUTING');
  assert.equal(d.action, 'INJECT_EXECUTION_TOOLS');
});

test('SCOUTING stays when drift is high', () => {
  const fsm = new WorkflowFSM();
  const d = fsm.tick({ rwRatio: 0.5, errorDensity: 0, drift: 0.4 });
  assert.equal(d.state, 'SCOUTING');
});

test('EXECUTING → DEBUGGING on error', () => {
  const fsm = new WorkflowFSM('EXECUTING');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0.2, drift: 0.05 });
  assert.equal(d.state, 'DEBUGGING');
  assert.equal(d.action, 'RESTRICT_WRITE_TOOLS');
});

test('EXECUTING → SCOUTING on large drift', () => {
  const fsm = new WorkflowFSM('EXECUTING');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0, drift: 0.4 });
  assert.equal(d.state, 'SCOUTING');
  assert.equal(d.action, 'RESTORE_ALL_TOOLS');
});

test('DEBUGGING → EXECUTING when error clears', () => {
  const fsm = new WorkflowFSM('DEBUGGING');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0, drift: 0.05 });
  assert.equal(d.state, 'EXECUTING');
  assert.equal(d.action, 'RESTORE_WRITE_TOOLS');
});

test('DEBUGGING → THRASHING when errors persist + drift spikes', () => {
  const fsm = new WorkflowFSM('DEBUGGING');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0.3, drift: 0.5 });
  assert.equal(d.state, 'THRASHING');
  assert.equal(d.action, 'FORCE_CONTEXT_COMPACTION');
});

test('THRASHING escalates to AWAIT_USER after 3 consecutive ticks', () => {
  const fsm = new WorkflowFSM('THRASHING');
  const t = { rwRatio: 1.0, errorDensity: 0.3, drift: 0.5 };
  fsm.tick(t); // ticks=1
  fsm.tick(t); // ticks=2
  const d = fsm.tick(t); // ticks=3 → AWAIT_USER
  assert.equal(d.state, 'AWAIT_USER');
  assert.equal(d.action, 'HALT_HOOK_EMISSION');
});

test('THRASHING can recover when errors clear and intent re-locks', () => {
  const fsm = new WorkflowFSM('THRASHING');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0, drift: 0.05 });
  assert.equal(d.state, 'EXECUTING');
  assert.equal(fsm.thrashingTicks, 0);
});

test('AWAIT_USER is terminal — needs reset()', () => {
  const fsm = new WorkflowFSM('AWAIT_USER');
  const d = fsm.tick({ rwRatio: 1.0, errorDensity: 0, drift: 0.05 });
  assert.equal(d.state, 'AWAIT_USER');
  assert.equal(d.action, 'HALT_HOOK_EMISSION');
  fsm.reset();
  assert.equal(fsm.currentState, 'SCOUTING');
  assert.equal(fsm.thrashingTicks, 0);
});

test('transitionTo is a no-op when target equals current', () => {
  const fsm = new WorkflowFSM('EXECUTING');
  fsm.transitionTo('EXECUTING', Date.now(), 'same');
  assert.equal(fsm.lastTransition, null);
});

test('persistence round-trip', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'fsm.json');
    const fsm = new WorkflowFSM('DEBUGGING', 2);
    fsm.lastTransition = { from: 'EXECUTING', to: 'DEBUGGING', at: 1745000000000, reason: 'x' };
    saveState(fsm, path);
    assert.ok(existsSync(path));

    const loaded = loadState(path);
    assert.equal(loaded.currentState, 'DEBUGGING');
    assert.equal(loaded.thrashingTicks, 2);
    assert.equal(loaded.lastTransition?.from, 'EXECUTING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState returns cold-start FSM on missing file (no mock data)', () => {
  const dir = tmp();
  try {
    const fsm = loadState(join(dir, 'missing.json'));
    assert.equal(fsm.currentState, 'SCOUTING');
    assert.equal(fsm.thrashingTicks, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadState rejects garbage payloads and cold-starts', () => {
  const dir = tmp();
  try {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, '{"currentState": "LOL", "thrashingTicks": "nope"}');
    const fsm = loadState(path);
    assert.equal(fsm.currentState, 'SCOUTING');
    assert.equal(fsm.thrashingTicks, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
