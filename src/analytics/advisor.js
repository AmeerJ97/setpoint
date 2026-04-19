/**
 * Advisory engine — dual-window analysis using rate engine projections.
 * Uses WindowProjection from rates.js which includes sigmoid-blended
 * projections, TTE, and per-window health levels.
 */

/**
 * @typedef {object} Advisory
 * @property {'increase'|'nominal'|'reduce'|'throttle'|'limit_hit'} signal
 * @property {string} reason
 * @property {{ effort: string, model: string }} suggestion
 * @property {import('./rates.js').WindowProjection|null} fiveHour
 * @property {import('./rates.js').WindowProjection|null} sevenDay
 * @property {number} burnRate
 * @property {'low'|'medium'|'high'} burnLevel
 * @property {number} estimatedSessions
 */

function classifyBurn(rate) {
  if (rate > 1000) return 'high';
  if (rate > 400) return 'medium';
  return 'low';
}

function formatTte(tteSec) {
  if (!tteSec || tteSec <= 0) return null;
  const mins = Math.floor(tteSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours >= 24 ? `${Math.floor(hours / 24)}d` : `${hours}h`;
}

/**
 * @param {import('./rates.js').RateData} rates
 * @param {import('../data/stdin.js').UsageData|null} usageData
 * @returns {Advisory}
 */
export function computeAdvisory(rates, usageData) {
  const burn = rates.burnRate;
  const burnLevel = classifyBurn(burn);
  const fiveHour = rates.fiveHourDetail ?? { current: null, projected: 0, level: 'ok', resetIn: null, tte: null, burnFracPerMin: 0 };
  const sevenDay = rates.sevenDayDetail ?? { current: null, projected: 0, level: 'ok', resetIn: null, tte: null, burnFracPerMin: 0 };
  const sessions = rates.estimatedSessions ?? 1;

  const base = { fiveHour, sevenDay, burnRate: burn, burnLevel, estimatedSessions: sessions };

  // No usage data
  if (!usageData) {
    return { signal: 'nominal', reason: 'no rate data', suggestion: { effort: 'high', model: 'opus' }, ...base };
  }

  // Limit hit
  if (fiveHour.level === 'hit' || sevenDay.level === 'hit') {
    const which = fiveHour.level === 'hit' ? '5h' : '7d';
    const resetIn = fiveHour.level === 'hit' ? fiveHour.resetIn : sevenDay.resetIn;
    return { signal: 'limit_hit', reason: `${which} limit reached${resetIn ? ` — resets ${resetIn}` : ''}`, suggestion: { effort: 'low', model: 'sonnet' }, ...base };
  }

  // Both critical
  if (fiveHour.level === 'critical' && sevenDay.level === 'critical') {
    return { signal: 'throttle', reason: `both windows critical — 5h→${pct(fiveHour.projected)} 7d→${pct(sevenDay.projected)}`, suggestion: { effort: 'low', model: 'sonnet' }, ...base };
  }

  // 5hr critical
  if (fiveHour.level === 'critical') {
    const tte = formatTte(fiveHour.tte);
    const tteStr = tte ? ` exhaust ~${tte}` : '';
    return { signal: 'throttle', reason: `5h→${pct(fiveHour.projected)}${tteStr}${fiveHour.resetIn ? ` resets ${fiveHour.resetIn}` : ''}`, suggestion: { effort: 'low', model: 'sonnet' }, ...base };
  }

  // 7d critical
  if (sevenDay.level === 'critical') {
    return { signal: 'throttle', reason: `7d→${pct(sevenDay.projected)} weekly budget critical`, suggestion: { effort: 'low', model: 'sonnet' }, ...base };
  }

  // Tight + high burn
  if (fiveHour.level === 'tight' && burnLevel === 'high') {
    const rem = fiveHour.current !== null ? 100 - fiveHour.current : 0;
    return { signal: 'reduce', reason: `5h tight ${rem}% left, burn ${Math.round(burn)}t/m`, suggestion: { effort: 'medium', model: 'opus' }, ...base };
  }

  // 7d tight
  if (sevenDay.level === 'tight') {
    const rem = sevenDay.current !== null ? 100 - sevenDay.current : 0;
    return { signal: 'reduce', reason: `7d budget ${rem}% remaining — pace yourself`, suggestion: { effort: 'medium', model: 'opus' }, ...base };
  }

  // Multi-session warning
  const sessionNote = sessions > 1 ? ` (${sessions} sessions)` : '';

  // Both ok
  if (fiveHour.level === 'ok' && sevenDay.level === 'ok') {
    const weekRem = sevenDay.current !== null ? 100 - sevenDay.current : 100;
    return { signal: 'increase', reason: `${weekRem}% weekly left — go hard${sessionNote}`, suggestion: { effort: 'high', model: 'opus' }, ...base };
  }

  // Ok + watch
  if (fiveHour.level === 'ok' && sevenDay.level === 'watch') {
    return { signal: 'increase', reason: `safe for high effort${sessionNote}`, suggestion: { effort: 'high', model: 'opus' }, ...base };
  }

  return { signal: 'nominal', reason: `on track${sessionNote}`, suggestion: { effort: 'high', model: 'opus' }, ...base };
}

function pct(v) { return `${Math.round(v * 100)}%`; }
