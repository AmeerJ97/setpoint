/**
 * Usage history writer — appends to usage-history.jsonl every 5 minutes.
 */
import { appendJsonl } from '../data/jsonl.js';
import { HISTORY_FILE } from '../data/paths.js';

/**
 * Write a history entry. Callers pass a sessionId so rate-projection
 * readers can filter to a single session's burn trajectory; account-
 * global rate-limit fields (fiveHourPct/sevenDayPct) stay account-global.
 * @param {object} params
 * @param {string|null} [params.sessionId]
 * @param {number|null} params.fiveHourPct
 * @param {number|null} params.sevenDayPct
 * @param {number} params.sessionBurnRate
 * @param {number} params.contextPct
 * @param {string} params.signal
 * @param {string} params.model
 * @param {string} params.effort
 * @param {number|null} [params.rtkSaved]
 * @param {number|null} [params.rtkSavingsPct]
 */
export function writeHistoryEntry({ sessionId, fiveHourPct, sevenDayPct, sessionBurnRate, contextPct, signal, model, effort, rtkSaved, rtkSavingsPct }) {
  const entry = {
    ts: new Date().toISOString(),
    session_id: sessionId ?? null,
    five_hour_pct: fiveHourPct ?? null,
    seven_day_pct: sevenDayPct ?? null,
    session_burn_rate: sessionBurnRate,
    context_pct: contextPct,
    signal,
    model,
    effort,
  };
  if (rtkSaved != null) entry.rtk_saved = rtkSaved;
  if (rtkSavingsPct != null) entry.rtk_savings_pct = rtkSavingsPct;
  appendJsonl(HISTORY_FILE, entry);
}
