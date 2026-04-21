#!/usr/bin/env node
/**
 * Analytics daemon — long-running background service.
 * Polls active sessions every 15s, writes token stats.
 * Writes usage history every 5 minutes.
 * Runs anomaly detection checks.
 */
import { findActiveSessions, findSessionJsonl } from '../data/session.js';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PLUGIN_DIR, TOKEN_STATS_LATEST, TOKEN_STATS_FILE, TOKEN_STATS_DIR, tokenStatsFileFor, HISTORY_FILE, RTK_STATS_FILE, RTK_STATS_DIR, rtkStatsFileFor, ROTATION } from '../data/paths.js';
import { writeHistoryEntry } from './history.js';
import { rotateJsonl, writeJsonAtomic } from '../data/jsonl.js';
import { costWeightedBurnRate } from './cost.js';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 15_000;
const HISTORY_INTERVAL_MS = 300_000;

let lastHistoryWrite = 0;

const RECENT_TURNS_TRACKED = 12;

export function analyzeSession(jsonlPath) {
  const s = {
    apiCalls: 0, userTurns: 0, models: {}, totalInput: 0, totalOutput: 0,
    totalCacheCreate: 0, totalCacheRead: 0, peakContext: 0,
    // TTL-split cache writes (Phase 1.4): exposed for the #46829
    // detector — when 1h ratio collapses, the sub-tier had a silent
    // regression to 5m even though ENABLE_PROMPT_CACHING_1H is set.
    totalCacheCreate5m: 0, totalCacheCreate1h: 0,
    tools: {}, mcps: {}, thinkingTurns: 0, agentSpawns: 0,
    firstTs: null, lastTs: null,
    // Rolling windows (newest last). recentTurnsOutput feeds the
    // sparkline; the cache series feed the rolling-window cache %
    // (Phase 1.4) which catches current cache regressions that the
    // session-cumulative figure dilutes.
    recentTurnsOutput: [],
    recentTurnsCacheCreate: [],
    recentTurnsCacheRead: [],
  };
  try {
    for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const ts = e.timestamp;
        if (ts) {
          if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
          if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
        }
        if (e.type === 'user') s.userTurns++;
        if (e.type === 'assistant') {
          const msg = e.message || {};
          const u = msg.usage || {};
          const model = msg.model || 'unknown';
          s.apiCalls++;
          s.models[model] = (s.models[model] || 0) + 1;
          const inTok = u.input_tokens || 0;
          const outTok = u.output_tokens || 0;
          const ccTok = u.cache_creation_input_tokens || 0;
          const crTok = u.cache_read_input_tokens || 0;
          const cc5m = u.cache_creation?.ephemeral_5m_input_tokens || 0;
          const cc1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
          s.totalInput += inTok;
          s.totalOutput += outTok;
          s.totalCacheCreate += ccTok;
          s.totalCacheRead += crTok;
          s.totalCacheCreate5m += cc5m;
          s.totalCacheCreate1h += cc1h;
          // Rolling window of per-turn output tokens for the sparkline
          s.recentTurnsOutput.push(outTok);
          if (s.recentTurnsOutput.length > RECENT_TURNS_TRACKED) s.recentTurnsOutput.shift();
          s.recentTurnsCacheCreate.push(ccTok);
          if (s.recentTurnsCacheCreate.length > RECENT_TURNS_TRACKED) s.recentTurnsCacheCreate.shift();
          s.recentTurnsCacheRead.push(crTok);
          if (s.recentTurnsCacheRead.length > RECENT_TURNS_TRACKED) s.recentTurnsCacheRead.shift();
          // Peak context = largest single-turn prefill (input + cache_read + cache_create).
          // Proxies "max tokens loaded into the model at any point this session".
          const turnContext = inTok + crTok + ccTok;
          if (turnContext > s.peakContext) s.peakContext = turnContext;
          if (Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if (b.type === 'thinking') s.thinkingTurns++;
              if (b.type === 'tool_use') {
                const n = b.name || '?';
                s.tools[n] = (s.tools[n] || 0) + 1;
                if (n === 'Agent' || n === 'Task') s.agentSpawns++;
                if (n.startsWith('mcp__')) {
                  const srv = n.split('__')[1] || '?';
                  s.mcps[srv] = (s.mcps[srv] || 0) + 1;
                }
              }
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch (err) { s.error = err.message; }
  return s;
}

function poll() {
  const sessions = findActiveSessions();
  const results = [];

  for (const sess of sessions) {
    const info = findSessionJsonl(sess.sessionId);
    if (!info) continue;
    const stats = analyzeSession(info.path);
    const dur = (stats.firstTs && stats.lastTs)
      ? Math.round((new Date(stats.lastTs) - new Date(stats.firstTs)) / 60000) : 0;
    results.push({
      ts: new Date().toISOString(), sid: sess.sessionId, pid: sess.pid,
      project: info.project, cwd: sess.cwd, dur, ...stats,
    });
  }

  mkdirSync(PLUGIN_DIR, { recursive: true });
  mkdirSync(TOKEN_STATS_DIR, { recursive: true });

  // Legacy aggregate for v1 readers — kept during overlap window,
  // will be removed in v2.1 once per-session files are the only path.
  writeFileSync(
    TOKEN_STATS_LATEST,
    JSON.stringify({ scannedAt: new Date().toISOString(), sessions: results }, null, 2),
  );

  // Per-session files. The renderer reads THIS session's file only.
  const aliveIds = new Set();
  for (const r of results) {
    aliveIds.add(r.sid);
    writeJsonAtomic(tokenStatsFileFor(r.sid), {
      writtenAt: new Date().toISOString(),
      ...r,
    });
    appendFileSync(TOKEN_STATS_FILE, JSON.stringify(r) + '\n');
  }

  // Clean up stale per-session files for sessions that have exited.
  // Prevents stale data lingering for a user who opens a new session
  // after closing an old one.
  try {
    for (const name of readdirSync(TOKEN_STATS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      if (!aliveIds.has(id)) {
        try { unlinkSync(join(TOKEN_STATS_DIR, name)); } catch { /* race ok */ }
      }
    }
  } catch { /* TOKEN_STATS_DIR brand-new; next poll will tidy */ }

  // Write history every 5 minutes — one entry per active session so
  // concurrent sessions never blend their burn rates in the history.
  const now = Date.now();
  if (now - lastHistoryWrite >= HISTORY_INTERVAL_MS && results.length > 0) {
    lastHistoryWrite = now;
    for (const r of results) {
      const model = Object.keys(r.models ?? {})[0] ?? 'unknown';
      const burn = costWeightedBurnRate(
        { ...r, durationMin: r.dur ?? 0 },
        model,
      );
      writeHistoryEntry({
        sessionId: r.sid,
        fiveHourPct: null,
        sevenDayPct: null,
        sessionBurnRate: burn,
        contextPct: 0,
        signal: 'nominal',
        model,
        effort: 'high',
      });
    }
  }

  // Rotate JSONL files if oversized
  rotateJsonl(TOKEN_STATS_FILE, ROTATION.TOKEN_STATS.maxBytes, ROTATION.TOKEN_STATS.keepLines);
  rotateJsonl(HISTORY_FILE, ROTATION.USAGE_HISTORY.maxBytes, ROTATION.USAGE_HISTORY.keepLines);

  // Poll RTK stats per session (not just the first). Each call is
  // fire-and-forget and writes into its own session-keyed file inside
  // pollRtk.
  for (const r of results) {
    pollRtk(r.sid, r.cwd ?? null).catch(() => {});
  }

  return results.length;
}

async function pollRtk(sessionId, projectPath) {
  try {
    const { stdout } = await execFileAsync(
      'rtk', ['gain', '--format', 'json'],
      { timeout: 2000, encoding: 'utf8' }
    );
    const global = JSON.parse(stdout)?.summary ?? null;

    let project = null;
    if (projectPath) {
      try {
        const { stdout: pOut } = await execFileAsync(
          'rtk', ['gain', '--format', 'json', '--project'],
          { timeout: 2000, encoding: 'utf8', cwd: projectPath }
        );
        project = JSON.parse(pOut)?.summary ?? null;
      } catch { /* project stats optional */ }
    }

    const payload = {
      fetchedAt: new Date().toISOString(),
      sessionId,
      global,
      project,
    };

    // Legacy global file (v1 readers) + per-session file (v2 readers).
    writeJsonAtomic(RTK_STATS_FILE, payload);
    if (sessionId) {
      mkdirSync(RTK_STATS_DIR, { recursive: true });
      writeJsonAtomic(rtkStatsFileFor(sessionId), payload);
    }
  } catch { /* RTK not installed or unavailable — silent */ }
}

function main() {
  console.log(`[analytics-daemon] Started, polling every ${POLL_INTERVAL_MS / 1000}s`);
  poll();

  setInterval(() => {
    try {
      const count = poll();
      if (count > 0) console.log(`[analytics-daemon] Scanned ${count} session(s)`);
    } catch (err) {
      console.error(`[analytics-daemon] Error: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);
}

// Only run the daemon loop when invoked directly as a script. Guard prevents
// tests (and any other importer) from starting a 60s setInterval.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const scriptPath = fileURLToPath(import.meta.url);
const argvPath = process.argv[1];
const isSamePath = (a, b) => {
  try { return realpathSync(a) === realpathSync(b); }
  catch { return a === b; }
};
if (argvPath && isSamePath(argvPath, scriptPath)) {
  main();
}
