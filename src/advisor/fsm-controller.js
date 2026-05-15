/**
 * Workflow FSM — cognitive-state routing over the telemetry triad.
 *
 * States:
 *   SCOUTING    — gathering context, R/W skewed to reads, no clear intent
 *   EXECUTING   — writing changes, output flowing, no errors
 *   DEBUGGING   — errors present, writes restricted cognitively
 *   THRASHING   — errors + intent drift, output is guessing
 *   AWAIT_USER  — terminal degenerate state, needs human reset
 *
 * Transition logic follows the spec but consumes the repo's calibrated
 * thresholds (`RE_RATIO_WARN`, `RE_RATIO_HEALTHY`) rather than literal
 * ratios — keeps the FSM aligned with the anomaly rule engine.
 *
 * Pure: `tick()` does no I/O. Callers handle persistence via the
 * helpers below, which use the same tmp-then-rename atomic pattern as
 * the effort-writer.
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RE_RATIO_WARN, RE_RATIO_HEALTHY } from '../anomaly/constants.js';
import { PLUGIN_DIR } from '../data/paths.js';
import { writeJsonAtomic } from '../data/jsonl.js';

export const FSM_STATE_FILE = join(PLUGIN_DIR, 'fsm-state.json');

/** @typedef {'SCOUTING'|'EXECUTING'|'DEBUGGING'|'THRASHING'|'AWAIT_USER'} AgentState */

/**
 * @typedef {object} Telemetry
 * @property {number} rwRatio - reads/edits ratio (Infinity when edits=0)
 * @property {number} errorDensity - failed tool calls / total tool calls
 * @property {number} drift - Jaccard distance to previous chunk tokens
 */

/**
 * @typedef {object} FsmSnapshot
 * @property {AgentState} currentState
 * @property {number} thrashingTicks
 * @property {{from: AgentState, to: AgentState, at: number, reason: string}|null} lastTransition
 */

const DRIFT_LOCKED = 0.15;      // intent has stabilized
const DRIFT_SHIFTED = 0.25;     // a new intent appeared
const DRIFT_THRASHING = 0.30;   // intent bouncing wildly
const THRASHING_ESCALATE_TICKS = 3;

/**
 * Pure FSM over telemetry. Keeps state in-memory so one process can
 * tick repeatedly; callers are responsible for serialising across
 * process boundaries via {@link saveState} / {@link loadState}.
 */
export class WorkflowFSM {
  /**
   * @param {AgentState} [initial='SCOUTING']
   * @param {number} [thrashingTicks=0]
   */
  constructor(initial = 'SCOUTING', thrashingTicks = 0) {
    /** @type {AgentState} */
    this.currentState = initial;
    this.thrashingTicks = thrashingTicks;
    /** @type {{from: AgentState, to: AgentState, at: number, reason: string}|null} */
    this.lastTransition = null;
  }

  /**
   * Evaluate telemetry, possibly transition, return the decision.
   *
   * @param {Telemetry} telemetry
   * @param {number} [now=Date.now()]
   * @returns {{ state: AgentState, action: string, reason: string }}
   */
  tick(telemetry, now = Date.now()) {
    const { rwRatio, errorDensity, drift } = telemetry ?? {};
    let action = 'NO_ACTION';
    let reason = 'metrics stable in current band';

    switch (this.currentState) {
      case 'SCOUTING':
        // Intent locked + reads no longer dominating → start executing.
        // `rwRatio < RE_RATIO_WARN` is the calibrated "writes starting
        // to catch up" threshold already used by the advisor engine.
        if (Number.isFinite(drift) && drift < DRIFT_LOCKED
            && Number.isFinite(rwRatio) && rwRatio < RE_RATIO_WARN) {
          this.transitionTo('EXECUTING', now, 'intent locked, writes beginning');
          action = 'INJECT_EXECUTION_TOOLS';
          reason = `drift ${drift.toFixed(2)} < ${DRIFT_LOCKED}, R:E ${fmtRatio(rwRatio)} < ${RE_RATIO_WARN}`;
        }
        break;

      case 'EXECUTING':
        if (Number.isFinite(errorDensity) && errorDensity > 0) {
          this.transitionTo('DEBUGGING', now, `errors present (density ${errorDensity.toFixed(2)})`);
          action = 'RESTRICT_WRITE_TOOLS';
          reason = `error density ${errorDensity.toFixed(2)} > 0`;
        } else if (Number.isFinite(drift) && drift > DRIFT_SHIFTED) {
          this.transitionTo('SCOUTING', now, 'new intent detected');
          action = 'RESTORE_ALL_TOOLS';
          reason = `drift ${drift.toFixed(2)} > ${DRIFT_SHIFTED}`;
        }
        break;

      case 'DEBUGGING':
        if (!Number.isFinite(errorDensity) || errorDensity === 0) {
          this.transitionTo('EXECUTING', now, 'errors resolved');
          action = 'RESTORE_WRITE_TOOLS';
          reason = 'error density back to 0';
          this.thrashingTicks = 0;
        } else if (Number.isFinite(drift) && drift > DRIFT_THRASHING) {
          this.transitionTo('THRASHING', now, 'errors + intent bouncing');
          action = 'FORCE_CONTEXT_COMPACTION';
          reason = `drift ${drift.toFixed(2)} > ${DRIFT_THRASHING} while errors persist`;
        }
        break;

      case 'THRASHING':
        this.thrashingTicks++;
        if (this.thrashingTicks >= THRASHING_ESCALATE_TICKS) {
          this.transitionTo('AWAIT_USER', now, `${this.thrashingTicks} thrashing ticks`);
          action = 'HALT_HOOK_EMISSION';
          reason = `${this.thrashingTicks} consecutive thrashing ticks — escalating to human`;
        } else if (Number.isFinite(errorDensity) && errorDensity === 0
                   && Number.isFinite(drift) && drift < DRIFT_LOCKED) {
          // Recovered on its own — go back to executing.
          this.transitionTo('EXECUTING', now, 'thrashing resolved');
          action = 'RESTORE_WRITE_TOOLS';
          reason = 'errors cleared and intent re-locked';
          this.thrashingTicks = 0;
        }
        break;

      case 'AWAIT_USER':
        // Terminal state — only `reset()` can escape. Human must ack.
        action = 'HALT_HOOK_EMISSION';
        reason = 'awaiting human reset';
        break;
    }

    return { state: this.currentState, action, reason };
  }

  /**
   * Move to a new state, record the transition. No-op if target equals
   * current state.
   *
   * @param {AgentState} newState
   * @param {number} at
   * @param {string} reason
   */
  transitionTo(newState, at, reason) {
    if (this.currentState === newState) return;
    this.lastTransition = { from: this.currentState, to: newState, at, reason };
    this.currentState = newState;
  }

  /**
   * Explicit human-driven reset. Used by CLI and by `/clear`.
   */
  reset() {
    this.currentState = 'SCOUTING';
    this.thrashingTicks = 0;
    this.lastTransition = null;
  }

  /**
   * @returns {FsmSnapshot}
   */
  snapshot() {
    return {
      currentState: this.currentState,
      thrashingTicks: this.thrashingTicks,
      lastTransition: this.lastTransition,
    };
  }
}

/**
 * Restore a FSM from its persisted snapshot. Returns a fresh FSM (at
 * SCOUTING, zero counter) when no state file exists or it's malformed —
 * an honest cold-start, not a silent guess.
 *
 * @param {string} [path]
 * @returns {WorkflowFSM}
 */
export function loadState(path = FSM_STATE_FILE) {
  try {
    if (!existsSync(path)) return new WorkflowFSM();
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    const state = isValidState(data?.currentState) ? data.currentState : 'SCOUTING';
    const ticks = Number.isFinite(data?.thrashingTicks) ? Math.max(0, Number(data.thrashingTicks)) : 0;
    const fsm = new WorkflowFSM(state, ticks);
    if (data?.lastTransition
        && isValidState(data.lastTransition.from)
        && isValidState(data.lastTransition.to)) {
      fsm.lastTransition = data.lastTransition;
    }
    return fsm;
  } catch {
    return new WorkflowFSM();
  }
}

/**
 * Atomic write of the FSM snapshot via writeJsonAtomic.
 * Safe across concurrent renders — last writer wins, no torn files.
 *
 * @param {WorkflowFSM} fsm
 * @param {string} [path]
 */
export function saveState(fsm, path = FSM_STATE_FILE) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, fsm.snapshot());
  } catch {
    /* persistence is best-effort; never fail the render */
  }
}

function isValidState(s) {
  return s === 'SCOUTING' || s === 'EXECUTING' || s === 'DEBUGGING'
      || s === 'THRASHING' || s === 'AWAIT_USER';
}

function fmtRatio(r) {
  if (!Number.isFinite(r)) return '∞';
  return r.toFixed(1);
}
