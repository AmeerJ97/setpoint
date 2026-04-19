/**
 * Identify top token-consuming sessions.
 * @param {object[]} sessions
 * @returns {{ top: Array<{project: string, tokens: number}>, summary: string }}
 */
export function analyzeTopConsumers(sessions) {
  const byProject = {};
  for (const s of sessions) {
    const proj = s.project ?? 'unknown';
    const tokens = (s.totalOutput ?? 0) + (s.totalCacheCreate ?? 0);
    byProject[proj] = (byProject[proj] ?? 0) + tokens;
  }

  const sorted = Object.entries(byProject)
    .map(([project, tokens]) => ({ project, tokens }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  const summary = sorted.length > 0
    ? `Top consumer: ${sorted[0].project} (${formatK(sorted[0].tokens)} tokens)`
    : 'No consumption data';

  return { top: sorted, summary };
}

function formatK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
