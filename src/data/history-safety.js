/**
 * Guardrails for usage-history provenance.
 *
 * Some local test fixtures intentionally use synthetic session ids/cwds. If
 * those payloads are ever piped into the live CLI, they can pollute
 * usage-history and mislead read-only diagnostics. These helpers keep
 * reconstruction paths focused on real telemetry.
 */

const FIXTURE_SESSION_PREFIX = 'fixture-';
const FIXTURE_PROJECT_SEGMENT = '/claude-ops-fixture';

/**
 * @param {object|null|undefined} row
 * @returns {boolean}
 */
export function isFixtureHistoryRow(row) {
  if (!row || typeof row !== 'object') return false;
  const sessionId = typeof row.session_id === 'string' ? row.session_id : '';
  if (sessionId.startsWith(FIXTURE_SESSION_PREFIX)) return true;
  const projectPath = typeof row.project_path === 'string' ? row.project_path : '';
  if (projectPath.includes(FIXTURE_PROJECT_SEGMENT)) return true;
  return false;
}

/**
 * @param {object[]|null|undefined} rows
 * @returns {object[]}
 */
export function filterTrustedHistoryRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter(row => !isFixtureHistoryRow(row));
}

/**
 * @param {object[]|null|undefined} rows
 * @returns {object|null}
 */
export function latestTrustedHistoryRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const trusted = filterTrustedHistoryRows(rows);
  if (trusted.length > 0) return trusted[trusted.length - 1] ?? null;
  return null;
}
