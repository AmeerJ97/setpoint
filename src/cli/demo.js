/**
 * `setpoint demo` — render a sample HUD in every color mode + glyph
 * policy, stacked vertically. Lets a user see instantly whether their
 * terminal supports sparklines, octant bars, and truecolor — and
 * which mode looks best in their theme.
 *
 * Doubles as README marketing material: the output is a compact
 * "what setpoint can look like" slide.
 */

import { render } from '../display/renderer.js';
import { setColorMode } from '../display/colors.js';
import { resetGlyphCache } from '../display/glyphs.js';

function sampleContext(sessionLabel) {
  return {
    stdin: {
      session_id: 'demo',
      model: { display_name: 'Opus 4.7', id: 'claude-opus-4-7' },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 48,
        current_usage: {
          input_tokens: 42_000, output_tokens: 9_500,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 30_000,
        },
      },
      rate_limits: {
        five_hour: { used_percentage: 62, resets_at: null },
        seven_day: { used_percentage: 38, resets_at: null },
      },
      cwd: '/tmp',
      transcript_path: '',
    },
    usageData: {
      fiveHour: 62, sevenDay: 38,
      fiveHourResetAt: null, sevenDayResetAt: null,
    },
    gitStatus: { branch: 'main', isDirty: false, ahead: 0, behind: 0 },
    sessionDuration: '23m',
    claudeMdCount: 2, rulesCount: 13, mcpCount: 12, hooksCount: 7,
    activeMcps: ['brave', 'perplexity', 'sentry'],
    effort: 'high',
    isCompressed: false,
    tokenStats: {
      totalInput: 42_000, totalOutput: 9_500,
      totalCacheCreate: 0, totalCacheRead: 30_000,
      apiCalls: 18, burnRate: 211,
      tools: { Read: 28, Edit: 7 }, mcps: {},
      agentSpawns: 2, durationMin: 23, peakContext: 80_500,
      recentTurnsOutput: [100, 300, 520, 940, 1_200, 780, 420, 200],
    },
    guardStatus: {
      running: true, activationsToday: 4,
      lastActivation: new Date(Date.now() - 2 * 60_000),
      lastFlag: 'brevity',
      flagCounts: { brevity: 2, summarize: 1, thinking: 1 },
      topFlag: 'brevity',
      skippedCount: 0,
      activationsPerHour: 2,
    },
    advisory: {
      signal: 'increase',
      reason: '38% weekly remaining',
      fiveHour: { current: 62, projected: 0.78, level: 'tight' },
      sevenDay: { current: 38, projected: 0.52, level: 'watch' },
      burnLevel: 'medium',
    },
    rates: null,
    compactionCount: 0,
    healthSummary: { mcpFailures: 0 },
    anomalies: [],
    toolCounts: { Read: 28, Edit: 7 },
    rtkStats: null,
    sessionId: sessionLabel ?? 'demo',
    activeSessionCount: 1,
    narrow: false,
  };
}

const MODES = [
  { heading: 'truecolor + cividis (default, colorblind-safe)',
    mode: 'truecolor', palette: 'cividis', env: {} },
  { heading: 'truecolor + rag (classic green/yellow/red)',
    mode: 'truecolor', palette: 'rag', env: {} },
  { heading: 'ansi256 + cividis (for 256-color terminals)',
    mode: 'ansi256', palette: 'cividis', env: {} },
  { heading: 'ansi16 (legacy 3-band fallback)',
    mode: 'ansi16', palette: 'cividis', env: {} },
  { heading: 'none (NO_COLOR / SETPOINT_PLAIN / non-TTY)',
    mode: 'none', palette: 'cividis', env: {} },
  { heading: 'SETPOINT_PLAIN=1 (ASCII-only glyphs)',
    mode: 'none', palette: 'cividis', env: { SETPOINT_PLAIN: '1' } },
  { heading: 'SETPOINT_NERD=1 (opt-in Nerd Font glyphs)',
    mode: 'truecolor', palette: 'cividis', env: { SETPOINT_NERD: '1' } },
];

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export function main() {
  process.stdout.write(`${BOLD}setpoint demo${RESET}  ${DIM}— one HUD, every render mode${RESET}\n`);
  process.stdout.write(`${DIM}Pick the one that looks right in your terminal. Set ${RESET}SETPOINT_PALETTE${DIM}/${RESET}SETPOINT_PLAIN${DIM}/${RESET}SETPOINT_NERD${DIM} to lock it in.${RESET}\n\n`);

  const savedEnv = { ...process.env };

  for (const { heading, mode, palette, env } of MODES) {
    // Tweak env for this iteration; glyph cache must be busted too.
    for (const k of ['SETPOINT_PLAIN', 'SETPOINT_NERD', 'SETPOINT_PALETTE', 'NO_COLOR']) {
      delete process.env[k];
    }
    Object.assign(process.env, env);

    setColorMode(mode, palette);
    resetGlyphCache();

    // Capture render output
    const lines = [];
    const writeOrig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { lines.push(chunk); return true; };
    try {
      render(sampleContext());
    } finally {
      process.stdout.write = writeOrig;
    }

    process.stdout.write(`${BOLD}▎ ${heading}${RESET}\n`);
    for (const chunk of lines) process.stdout.write(chunk);
    process.stdout.write('\n');
  }

  // Restore env & auto-detect
  process.env = savedEnv;
  setColorMode(null);
  resetGlyphCache();
  return 0;
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  process.exit(main());
}
