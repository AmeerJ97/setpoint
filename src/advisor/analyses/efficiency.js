/**
 * Usage efficiency — two distinct signals.
 *
 *   score:           output / (input + output)
 *                    "how much of what the model processed ended up as output"
 *                    Ignores cache cost entirely — sensitive to prompt length.
 *
 *   productiveRatio: output / (input + output + cacheCreate)
 *                    "how much of total investment (including cache priming)
 *                    became output". Lower when sessions do heavy cache
 *                    creation.
 *
 * cacheRead is excluded from both denominators — it is reused state, not new cost.
 *
 * @param {object[]} sessions - token stats entries
 * @returns {{ score: number, productiveRatio: number, summary: string }}
 */
export function analyzeEfficiency(sessions) {
  if (!sessions.length) return { score: 0, productiveRatio: 0, summary: 'No session data' };

  let totalOutput = 0;
  let totalInput = 0;
  let totalCacheCreate = 0;
  for (const s of sessions) {
    totalOutput += (s.totalOutput ?? 0);
    totalInput += (s.totalInput ?? 0);
    totalCacheCreate += (s.totalCacheCreate ?? 0);
  }

  const scoreDenom = totalInput + totalOutput;
  const ratioDenom = totalInput + totalOutput + totalCacheCreate;

  const score = scoreDenom > 0 ? Math.round((totalOutput / scoreDenom) * 100) : 0;
  const productiveRatio = ratioDenom > 0 ? Math.round((totalOutput / ratioDenom) * 100) : 0;

  return {
    score,
    productiveRatio,
    summary: `Efficiency: ${score}% output-share, ${productiveRatio}% of total invest (${formatK(totalOutput)} out / ${formatK(ratioDenom)} invest)`,
  };
}

function formatK(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
}
