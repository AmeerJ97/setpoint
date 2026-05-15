import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectVertexSnapshot } from './telemetry.js';

const now = Date.parse('2026-05-13T12:00:00.000Z');

function writeSeries(dir) {
  const path = join(dir, 'series.json');
  writeFileSync(path, JSON.stringify([
    {
      metric: { labels: { type: 'input' } },
      points: [
        { interval: { endTime: '2026-05-13T11:00:00.000Z' }, value: { int64Value: '100' } },
        { interval: { endTime: '2026-05-12T11:00:00.000Z' }, value: { int64Value: '50' } },
      ],
    },
    {
      metric: { labels: { type: 'output' } },
      points: [
        { interval: { endTime: '2026-05-13T10:30:00.000Z' }, value: { int64Value: '25' } },
      ],
    },
  ]));
  return path;
}

test('Vertex telemetry collector builds metrics-only snapshots from monitoring series', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-telemetry-'));
  try {
    const result = collectVertexSnapshot({
      fromFile: writeSeries(dir),
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      },
    }, { now });

    assert.equal(result.ok, true);
    assert.equal(result.snapshot.telemetry_authority, 'vertex-metrics-estimate');
    assert.equal(result.snapshot.project_id, 'project-a');
    assert.equal(result.snapshot.region, 'us-east5');
    assert.equal(result.snapshot.five_hour.total_tokens, 125);
    assert.equal(result.snapshot.five_hour.input_tokens, 100);
    assert.equal(result.snapshot.five_hour.output_tokens, 25);
    assert.equal(result.snapshot.seven_day.total_tokens, 175);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Vertex telemetry collector requires complete cost windows for vertex-api authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-ops-vertex-telemetry-cost-'));
  try {
    const fromFile = writeSeries(dir);
    const partial = collectVertexSnapshot({
      fromFile,
      costSource: 'billing-export',
      fiveHourCostUsd: '1.25',
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      },
    }, { now });
    assert.equal(partial.ok, true);
    assert.equal(partial.snapshot.telemetry_authority, 'vertex-metrics-estimate');

    const complete = collectVertexSnapshot({
      fromFile,
      costSource: 'billing-export',
      fiveHourCostUsd: '1.25',
      sevenDayCostUsd: '9.5',
      env: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'project-a',
        CLOUD_ML_REGION: 'us-east5',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      },
    }, { now });
    assert.equal(complete.ok, true);
    assert.equal(complete.snapshot.telemetry_authority, 'vertex-api');
    assert.equal(complete.snapshot.five_hour.cost_usd, 1.25);
    assert.equal(complete.snapshot.seven_day.cost_usd, 9.5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
