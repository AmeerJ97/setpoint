import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHookOutput, formatUserPromptSubmitOutput } from './emit.js';

test('formatUserPromptSubmitOutput uses current Claude Code additionalContext contract', () => {
  const out = formatUserPromptSubmitOutput('Read before edit.');
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Read before edit.',
    },
  });
  assert.equal(Object.hasOwn(out, 'systemMessage'), false);
});

test('formatHookOutput preserves event name for advisory hook output', () => {
  const out = formatHookOutput({ eventName: 'PreCompact', body: 'snapshot captured', mode: 'advisory' });
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'PreCompact',
      additionalContext: 'snapshot captured',
    },
  });
});

test('formatHookOutput can emit explicit blocking decisions when configured', () => {
  const out = formatHookOutput({ eventName: 'UserPromptSubmit', body: 'blocked for test', mode: 'blocking' });
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      decision: 'block',
      reason: 'blocked for test',
    },
  });
});
