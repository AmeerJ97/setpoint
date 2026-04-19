/**
 * Weekly consumption trend — direction, magnitude, and top driver.
 * @param {object[]} historyEntries - from usage-history.jsonl
 * @param {object[]} [sessions] - from token-stats.jsonl (for per-project breakdown)
 * @returns {{ trend: 'increasing'|'decreasing'|'stable', changePct: number, summary: string }}
 */
export function analyzeWeeklyTrend(historyEntries, sessions = []) {
  if (historyEntries.length < 10) {
    return { trend: 'stable', changePct: 0, summary: 'Insufficient data for trend analysis' };
  }

  const mid = Math.floor(historyEntries.length / 2);
  const firstHalf = historyEntries.slice(0, mid);
  const secondHalf = historyEntries.slice(mid);

  const avgFirst = avg(firstHalf.map(e => e.session_burn_rate ?? 0));
  const avgSecond = avg(secondHalf.map(e => e.session_burn_rate ?? 0));

  const changePct = avgFirst > 0 ? Math.round(((avgSecond - avgFirst) / avgFirst) * 100) : 0;

  let trend = 'stable';
  let summary = 'Burn rate stable';

  if (changePct > 15) {
    trend = 'increasing';
    summary = `Burn rate increasing ${changePct}% (${Math.round(avgFirst)}→${Math.round(avgSecond)} t/min)`;
  } else if (changePct < -15) {
    trend = 'decreasing';
    summary = `Burn rate decreasing ${Math.abs(changePct)}% (${Math.round(avgFirst)}→${Math.round(avgSecond)} t/min)`;
  }

  // Per-project driver analysis (if sessions available)
  if (sessions.length > 0 && trend !== 'stable') {
    const driver = findTopDriver(sessions);
    if (driver) {
      summary += ` — top driver: ${driver}`;
    }
  }

  return { trend, changePct, summary };
}

/**
 * Find the project with highest total output tokens.
 * @param {object[]} sessions
 * @returns {string|null}
 */
function findTopDriver(sessions) {
  const byProject = {};
  for (const s of sessions) {
    const proj = s.project ?? 'unknown';
    byProject[proj] = (byProject[proj] ?? 0) + (s.totalOutput ?? 0);
  }
  const sorted = Object.entries(byProject).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : null;
}

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
