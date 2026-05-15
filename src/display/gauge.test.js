import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { combinedGauge } from './gauge.js';
import { setColorMode } from './colors.js';

afterEach(() => setColorMode(null));

test('combinedGauge respects color mode none', () => {
  setColorMode('none', 'cividis');
  const rendered = combinedGauge({ label: '5h', current: 62, projected: 0.78, level: 'tight' });
  assert.doesNotMatch(rendered, /\x1b\[[0-9;]*m/);
  assert.match(rendered, /62→78/);
});
