/**
 * Explicit provider telemetry collectors.
 *
 * These commands are intentionally out of the statusLine render path. The HUD
 * reads snapshots; operators run collectors when they want provider-backed
 * telemetry.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERTEX_API_TELEMETRY_FILE } from '../data/paths.js';
import { buildVertexTelemetryContext } from '../analytics/vertex-telemetry.js';

const TOKEN_METRIC = 'aiplatform.googleapis.com/publisher/online_serving/token_count';
const FIVE_HOUR_MS = 5 * 3600 * 1000;
const SEVEN_DAY_MS = 7 * 86400 * 1000;

export function main(argv = process.argv.slice(2), options = {}) {
  const [provider, action, ...rest] = argv;
  if (provider !== 'vertex' || action !== 'collect') {
    printUsage(provider ? `unknown telemetry command: ${argv.join(' ')}` : null);
    return provider ? 2 : 0;
  }

  const opts = parseArgs(rest, options.env ?? process.env);
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (opts.error) {
    printUsage(opts.error);
    return 2;
  }
  const result = collectVertexSnapshot(opts, options);

  if (opts.write && result.ok) {
    writeJsonAtomic(opts.write, result.snapshot);
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.ok ? result.snapshot : result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`vertex telemetry: ${result.snapshot.telemetry_authority} ${result.snapshot.retrieved_at}\n`);
  } else {
    process.stderr.write(`vertex telemetry: ${result.error}\n`);
  }

  return result.ok ? 0 : 1;
}

export function collectVertexSnapshot(opts, options = {}) {
  const now = options.now ?? Date.now();
  const env = opts.env ?? options.env ?? process.env;
  const envContext = buildVertexTelemetryContext(env);
  const context = {
    ...envContext,
    projectId: opts.project ?? envContext.projectId,
    region: opts.region ?? envContext.region,
    model: opts.model ?? envContext.model,
    endpoint: opts.endpoint ?? envContext.endpoint,
  };

  if (!context.projectId) return fail('missing Vertex project id; pass --project or set ANTHROPIC_VERTEX_PROJECT_ID');
  if (!context.region) return fail('missing Vertex region; pass --region or set CLOUD_ML_REGION / VERTEX_REGION_CLAUDE_*');
  if (!context.model) return fail('missing Vertex model; pass --model or set ANTHROPIC_MODEL');

  const series = opts.fromFile
    ? readJsonArray(opts.fromFile)
    : readGcloudTokenSeries(context, env);
  if (!series.ok) return series;

  const windows = aggregateTokenSeries(series.data, now);
  const costSource = opts.costSource ?? null;
  const fiveHourCost = finite(opts.fiveHourCostUsd);
  const sevenDayCost = finite(opts.sevenDayCostUsd);
  const costBacked = costSource && fiveHourCost != null && sevenDayCost != null;

  const snapshot = {
    schema_version: 1,
    telemetry_authority: costBacked ? 'vertex-api' : 'vertex-metrics-estimate',
    retrieved_at: new Date(now).toISOString(),
    project_id: context.projectId,
    region: context.region,
    model: context.model,
    endpoint: context.endpoint ?? null,
    source: opts.fromFile ? 'file:gcloud-monitoring' : 'gcloud-monitoring',
    metric_source: TOKEN_METRIC,
    cost_source: costSource,
    currency: 'USD',
    five_hour: {
      ...windows.fiveHour,
      ...(fiveHourCost == null ? {} : { cost_usd: fiveHourCost }),
    },
    seven_day: {
      ...windows.sevenDay,
      ...(sevenDayCost == null ? {} : { cost_usd: sevenDayCost }),
    },
  };

  return { ok: true, snapshot };
}

function parseArgs(argv, env) {
  const opts = {
    json: false,
    write: env.CLAUDE_OPS_VERTEX_API_TELEMETRY_FILE ?? VERTEX_API_TELEMETRY_FILE,
    env,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': opts.json = true; break;
      case '--no-write': opts.write = null; break;
      case '--write': opts.write = argv[++i] ?? opts.write; break;
      case '--project': opts.project = argv[++i]; break;
      case '--region': opts.region = argv[++i]; break;
      case '--model': opts.model = argv[++i]; break;
      case '--endpoint': opts.endpoint = argv[++i]; break;
      case '--from-file': opts.fromFile = argv[++i]; break;
      case '--cost-source': opts.costSource = argv[++i]; break;
      case '--five-hour-cost-usd': opts.fiveHourCostUsd = argv[++i]; break;
      case '--seven-day-cost-usd': opts.sevenDayCostUsd = argv[++i]; break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        opts.error = `unknown option: ${a}`;
        break;
    }
  }
  return opts;
}

function readGcloudTokenSeries(context, env) {
  const token = spawnSync('gcloud', ['auth', 'application-default', 'print-access-token'], { encoding: 'utf8', env });
  if (token.error?.code === 'ENOENT') return fail('gcloud not found on PATH');
  if (token.status !== 0) return fail((token.stderr || token.stdout || 'failed to read ADC token').trim());

  const filter = [
    `metric.type="${TOKEN_METRIC}"`,
    `resource.labels.location="${context.region}"`,
  ].join(' AND ');
  const endTime = new Date().toISOString();
  const startTime = new Date(Date.now() - SEVEN_DAY_MS).toISOString();
  let pageToken = null;
  const rows = [];

  for (let i = 0; i < 10; i++) {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${context.projectId}/timeSeries`);
    url.searchParams.set('filter', filter);
    url.searchParams.set('interval.startTime', startTime);
    url.searchParams.set('interval.endTime', endTime);
    url.searchParams.set('view', 'FULL');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const out = spawnSync('curl', [
      '-sS',
      '-H', `Authorization: Bearer ${String(token.stdout).trim()}`,
      '-H', `x-goog-user-project: ${context.projectId}`,
      url.toString(),
    ], { encoding: 'utf8', env });
    if (out.error?.code === 'ENOENT') return fail('curl not found on PATH');
    if (out.status !== 0) return fail((out.stderr || out.stdout || 'Cloud Monitoring query failed').trim());

    let parsed;
    try {
      parsed = JSON.parse(out.stdout || '{}');
    } catch {
      return fail('Cloud Monitoring returned invalid JSON');
    }
    if (parsed?.error?.message) return fail(parsed.error.message);
    rows.push(...(Array.isArray(parsed.timeSeries) ? parsed.timeSeries : []));
    pageToken = parsed.nextPageToken ?? null;
    if (!pageToken) break;
  }

  return { ok: true, data: rows };
}

function aggregateTokenSeries(series, now) {
  const rows = [];
  for (const ts of Array.isArray(series) ? series : []) {
    const labels = ts.metric?.labels ?? {};
    const tokenType = String(labels.type ?? labels.token_type ?? labels.direction ?? '').toLowerCase();
    for (const point of Array.isArray(ts.points) ? ts.points : []) {
      const end = Date.parse(point.interval?.endTime ?? point.interval?.end_time ?? point.endTime ?? '');
      if (!Number.isFinite(end)) continue;
      const value = pointValue(point.value);
      if (value == null) continue;
      rows.push({ end, tokenType, value });
    }
  }
  return {
    fiveHour: aggregateWindow(rows, now - FIVE_HOUR_MS),
    sevenDay: aggregateWindow(rows, now - SEVEN_DAY_MS),
  };
}

function aggregateWindow(rows, cutoff) {
  const totals = {
    total_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_create_tokens: 0,
    cache_read_tokens: 0,
    api_calls: 0,
  };
  for (const row of rows) {
    if (row.end < cutoff) continue;
    totals.total_tokens += row.value;
    if (/output/.test(row.tokenType)) totals.output_tokens += row.value;
    else if (/cache.*read/.test(row.tokenType)) totals.cache_read_tokens += row.value;
    else if (/cache.*(create|write)/.test(row.tokenType)) totals.cache_create_tokens += row.value;
    else totals.input_tokens += row.value;
  }
  return totals;
}

function pointValue(value) {
  if (!value || typeof value !== 'object') return null;
  return finite(value.int64Value ?? value.doubleValue ?? value.value);
}

function readJsonArray(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return { ok: true, data };
  } catch (error) {
    return fail(`failed to read ${path}: ${error.message}`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function finite(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function fail(error) {
  return { ok: false, error };
}

function printUsage(err) {
  if (err) process.stderr.write(`claude-ops telemetry: ${err}\n\n`);
  process.stdout.write(`\
claude-ops telemetry vertex collect [--json] [--write PATH] [--project ID] [--region REGION] [--model MODEL]

Collect Vertex token telemetry explicitly and write a HUD-readable snapshot.
Cost fields are authoritative only when --cost-source and cost values are supplied.
`);
}

if (process.argv[1] && process.argv[1].endsWith('/telemetry.js')) {
  process.exit(main(process.argv.slice(2)));
}
