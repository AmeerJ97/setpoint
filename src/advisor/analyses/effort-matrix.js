/**
 * Recommend optimal effort/model based on trailing usage + RTK savings.
 *
 * Precedence (highest to lowest):
 * 1. limit_hit in recent history → low/sonnet (hard constraint)
 * 2. avgSevenDay > 80 OR avgFiveHr > 90 → medium/sonnet (tight budget)
 * 3. avgSevenDay > 60 AND avgFiveHr > 70 → medium/opus (moderate constraint)
 * 4. RTK savings > 80% → high/opus (savings offset cost)
 * 5. default → high/opus
 *
 * @param {object[]} historyEntries - from usage-history.jsonl
 * @param {{ avgSavingsPct?: number }|null} [rtkStats] - RTK savings data
 * @returns {{ effort: string, model: string, summary: string, costNote: string|null }}
 */
export function analyzeEffortMatrix(historyEntries, rtkStats = null) {
  if (!historyEntries.length) {
    return { effort: 'high', model: 'opus', summary: 'No history — default to high/opus', costNote: null };
  }

  const avgFiveHr = avg(historyEntries.map(e => e.five_hour_pct).filter(v => v != null));
  const avgSevenDay = avg(historyEntries.map(e => e.seven_day_pct).filter(v => v != null));
  const hasLimitHit = historyEntries.some(e => e.signal === 'limit_hit');
  const rtkPct = rtkStats?.avgSavingsPct ?? 0;

  // Cost note: Opus output=$75/M, Sonnet output=$15/M
  const costNote = `Opus $75/M out vs Sonnet $15/M out (5x)`;

  // 1. Hard constraint: limit was hit recently
  if (hasLimitHit) {
    return {
      effort: 'low', model: 'sonnet',
      summary: `Limit hit in trailing week — recommend low/sonnet until budget recovers`,
      costNote,
    };
  }

  // 2. Tight budget: high average across either window
  if (avgSevenDay > 80 || avgFiveHr > 90) {
    const which = avgSevenDay > 80 ? `7d avg ${Math.round(avgSevenDay)}%` : `5h avg ${Math.round(avgFiveHr)}%`;
    return {
      effort: 'medium', model: 'sonnet',
      summary: `Budget tight (${which}) — recommend medium/sonnet`,
      costNote,
    };
  }

  // 3. Moderate constraint: both windows elevated
  if (avgSevenDay > 60 && avgFiveHr > 70) {
    return {
      effort: 'medium', model: 'opus',
      summary: `Moderate usage (7d:${Math.round(avgSevenDay)}% 5h:${Math.round(avgFiveHr)}%) — recommend medium/opus`,
      costNote,
    };
  }

  // 4. RTK offsetting cost — safe for high effort
  if (rtkPct > 80) {
    return {
      effort: 'high', model: 'opus',
      summary: `Safe headroom + RTK saving ${Math.round(rtkPct)}% — high/opus ok`,
      costNote: null, // RTK offsets concern
    };
  }

  // 5. Default: plenty of headroom
  return {
    effort: 'high', model: 'opus',
    summary: `Safe headroom — high/opus ok`,
    costNote: null,
  };
}

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}
