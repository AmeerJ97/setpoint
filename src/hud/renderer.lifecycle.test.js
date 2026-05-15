import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyticsKickDue } from './renderer.js';

test('analyticsKickDue throttles systemd starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-hud-'));
  const marker = join(dir, 'analytics-start.last');
  try {
    assert.equal(analyticsKickDue(marker, 10_000, 60_000), true);
    writeFileSync(marker, '2026-05-03T00:00:00.000Z\n');
    assert.equal(analyticsKickDue(marker, Date.now(), 60_000), false);
    assert.equal(analyticsKickDue(marker, Date.now() + 61_000, 60_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
