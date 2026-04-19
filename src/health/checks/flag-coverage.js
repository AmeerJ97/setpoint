/**
 * Flag coverage check — detects unprotected GrowthBook flags.
 * Compares all tengu_* flags in ~/.claude.json against the guard's protected set.
 */
import { readFileSync, existsSync } from 'node:fs';
import { CLAUDE_JSON_PATH } from '../../data/paths.js';

// Flags actively protected by the quality guard service (top-level GrowthBook keys)
const PROTECTED_FLAGS = new Set([
  // verbosity / suppression
  'tengu_swann_brevity',
  'tengu_sotto_voce',
  'quiet_fern',
  'quiet_hollow',
  'tengu_summarize_tool_results',

  // quotas / limits / refresh
  'tengu_amber_wren',
  'tengu_pewter_kestrel',
  'tengu_willow_refresh_ttl_hours',

  // connectors / bridge
  'tengu_claudeai_mcp_connectors',

  // effort reducers / capability downgrades
  'tengu_grey_step',
  'tengu_grey_step2',
  'tengu_grey_wool',
  'tengu_crystal_beam',
  'tengu_willow_mode',

  // compaction
  'tengu_sm_compact_config',
  'tengu_sm_config',
  'tengu_tool_result_persistence',

  // processing
  'tengu_chomp_inflection',
]);

/**
 * Check for GrowthBook flags not covered by the quality guard.
 * @returns {Array<{severity: string, check: string, message: string}>}
 */
export function checkFlagCoverage() {
  const issues = [];

  if (!existsSync(CLAUDE_JSON_PATH)) return issues;

  try {
    const content = readFileSync(CLAUDE_JSON_PATH, 'utf8');
    const data = JSON.parse(content);
    const features = data.cachedGrowthBookFeatures ?? {};

    const allFlags = Object.keys(features).filter(k => k.startsWith('tengu_') || k.startsWith('quiet_'));
    const unprotected = allFlags.filter(k => !PROTECTED_FLAGS.has(k));

    issues.push({
      severity: 'info',
      check: 'flag-coverage',
      message: `GrowthBook flags: ${allFlags.length} total, ${PROTECTED_FLAGS.size} protected, ${unprotected.length} unprotected`,
    });

    if (unprotected.length > 20) {
      const sample = unprotected.slice(0, 5).join(', ');
      issues.push({
        severity: 'info',
        check: 'flag-coverage',
        message: `Unprotected flags sample: ${sample} (+${unprotected.length - 5} more)`,
      });
    }
  } catch { /* ignore parse errors */ }

  return issues;
}
