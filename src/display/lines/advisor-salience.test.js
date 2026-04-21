import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSalienceSegment } from './advisor-salience.js';

const strip = s => (s == null ? s : s.replace(/\x1b\[[0-9;]*m/g, ''));

test('burnVelocity ≥ 2× P50 wins salience slot', () => {
  const seg = strip(pickSalienceSegment(
    { metrics: { burnVelocity: 2.3, ratio: 5, edits: 5 } },
    { peakFraction: 0.9, peakMultiplier: 1.5 },
  ));
  assert.match(seg, /⚡ burn 2\.3× P50/);
});

test('peak dominance fires when burn is normal but peak share ≥ 60%', () => {
  const seg = strip(pickSalienceSegment(
    { metrics: { burnVelocity: 1.0, ratio: 5, edits: 5 } },
    { peakFraction: 0.75, peakMultiplier: 1.5 },
  ));
  assert.match(seg, /◆ peak 75%/);
});

test('R:E degraded shows when edits ≥ RE_MIN and ratio < WARN', () => {
  const seg = strip(pickSalienceSegment(
    { metrics: { burnVelocity: 1.0, ratio: 0.8, edits: 5 } },
    { peakFraction: 0.1, peakMultiplier: 1.5 },
  ));
  assert.match(seg, /◐ R:E 0\.8/);
});

test('nothing rendered when all metrics are within band', () => {
  const seg = pickSalienceSegment(
    { metrics: { burnVelocity: 1.0, ratio: 5, edits: 5 } },
    { peakFraction: 0.1, peakMultiplier: 1.5 },
  );
  assert.equal(seg, null);
});

test('omits segment when baseline is missing (burnVelocity=null)', () => {
  const seg = pickSalienceSegment(
    { metrics: { burnVelocity: null, ratio: 5, edits: 5 } },
    { peakFraction: 0.1, peakMultiplier: 1.5 },
  );
  assert.equal(seg, null);
});

test('omits R:E segment when edits below min (not enough signal)', () => {
  const seg = pickSalienceSegment(
    { metrics: { burnVelocity: 1.0, ratio: 0.5, edits: 1 } },
    { peakFraction: 0, peakMultiplier: 1 },
  );
  assert.equal(seg, null);
});

test('peak segment silent when peakMultiplier = 1 (no peak inflation)', () => {
  const seg = pickSalienceSegment(
    { metrics: { burnVelocity: 1.0, ratio: 5, edits: 5 } },
    { peakFraction: 0.9, peakMultiplier: 1 },
  );
  assert.equal(seg, null);
});

test('burn takes priority over peak when both would fire', () => {
  const seg = strip(pickSalienceSegment(
    { metrics: { burnVelocity: 3.0, ratio: 5, edits: 5 } },
    { peakFraction: 0.9, peakMultiplier: 1.5 },
  ));
  assert.match(seg, /burn 3\.0× P50/);
  assert.doesNotMatch(seg, /peak/);
});
