/**
 * RTK efficiency analysis — token savings and dollar impact.
 * @param {{ totalCommands?: number, totalSaved?: number, avgSavingsPct?: number }|null} rtkStats
 * @returns {{ summary: string, dollarSaved: number, details: string[] }}
 */
export function analyzeRtkEfficiency(rtkStats) {
  if (!rtkStats || !rtkStats.totalSaved) {
    return { summary: 'RTK: no data', dollarSaved: 0, details: [] };
  }

  const saved = rtkStats.totalSaved;
  const pct = Math.round(rtkStats.avgSavingsPct ?? 0);
  const cmds = rtkStats.totalCommands ?? 0;

  // Input token cost at Opus rate: $15/M tokens
  // RTK saves input tokens (compressed output = fewer input tokens consumed)
  const dollarSaved = (saved / 1_000_000) * 15;

  const details = [
    `Commands optimized: ${cmds}`,
    `Tokens saved: ${formatK(saved)} (${pct}% avg compression)`,
    `Estimated savings: $${dollarSaved.toFixed(2)} at Opus input rates`,
  ];

  return {
    summary: `RTK: ${formatK(saved)} tokens saved (${pct}%) across ${cmds} commands — $${dollarSaved.toFixed(2)} saved`,
    dollarSaved,
    details,
  };
}

function formatK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
