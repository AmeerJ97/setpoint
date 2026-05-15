import { collectGuardState } from '../../cli/guard-status.js';
import { collectVertexConfigState } from '../../guard/vertex-config.js';
import { inspectGuardControl } from '../../guard/mode-control.js';
import { buildGuardPresentationSummary, collectGuardValidationState } from '../../guard/guard-validation.js';

export function checkGuardDrift() {
  try {
    const rows = collectGuardState();
    const validation = collectGuardValidationState();
    const summary = buildGuardPresentationSummary(rows, validation);
    const vertexConfig = collectVertexConfigState();
    const drift = summary.official.controls.drift;
    const skipped = summary.skipped.total;
    const guard = inspectGuardControl();
    const enforcing = guard.mode === 'enforce';
    const apiTelemetryBypass = Boolean(vertexConfig.apiTelemetryBypass);
    const vertexDetail = (vertexConfig.configured || vertexConfig.active) ? '; vertex:' + vertexConfig.state : '';
    const bypassDetail = apiTelemetryBypass ? '; vertex-api-bypass:on' : '';
    const modeLabel = guard.mode === 'disabled' ? 'guard disabled' : (enforcing ? 'guard enforcing' : 'guard audit-only');
    return [{
      severity: guardDriftSeverity(drift, enforcing, apiTelemetryBypass),
      check: 'guard-drift',
      message: modeLabel
        + '; docs held:' + summary.official.controls.held
        + ' drift:' + drift
        + ' info:' + summary.official.controls.info
        + '; internal probes:' + summary.internal.total
        + ' raw-drift:' + summary.internal.probe
        + ' skipped:' + skipped
        + vertexDetail
        + bypassDetail,
      drift,
      officialDrift: drift,
      internalProbe: summary.internal.probe,
      skipped,
      enforcing,
      mode: guard.mode,
      apiTelemetryBypass,
      vertexConfig,
      summary,
    }];
  } catch {
    return [{
      severity: 'warning',
      check: 'guard-drift',
      message: 'guard status could not be read',
    }];
  }
}

function guardDriftSeverity(drift, enforcing, apiTelemetryBypass = false) {
  if (apiTelemetryBypass) return 'warning';
  return drift > 0 && enforcing ? 'warning' : 'info';
}

export { guardDriftSeverity };
