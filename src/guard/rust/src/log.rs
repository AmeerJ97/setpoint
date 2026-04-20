//! Append-only activation log. One line per non-empty apply pass, matching
//! the bash version's format so existing parsers (HUD guard line, anomaly
//! detector) keep working byte-for-byte.
//!
//! Format: `<RFC3339-with-tz> Re-applied: <flag,flag,...> (<count> overrides)`

use std::io::Write;
use std::path::Path;

use crate::overrides::Report;

pub fn write(log_file: &Path, report: &Report) -> Result<(), String> {
    if report.changed.is_empty() {
        return Ok(());
    }
    let line = format!(
        "{} Re-applied: {} ({} overrides)\n",
        timestamp(),
        report.changed.join(","),
        report.changed.len()
    );
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file)
        .map_err(|e| format!("open {log_file:?}: {e}"))?;
    f.write_all(line.as_bytes())
        .map_err(|e| format!("write log: {e}"))?;
    Ok(())
}

/// RFC 3339 with local-offset suffix. We avoid pulling in `chrono` — date(1)
/// formatting is only ~80 chars of math and the bash version's parsers are
/// permissive about the offset shape (`+HH:MM` or `Z`).
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let nanos = now.subsec_nanos();
    let offset = local_offset_seconds().unwrap_or(0);
    let local = secs + offset as i64;
    let (y, mo, d, h, mi, s) = ymd_hms(local);

    let off_sign = if offset >= 0 { '+' } else { '-' };
    let off_abs = offset.unsigned_abs();
    let off_h = off_abs / 3600;
    let off_m = (off_abs % 3600) / 60;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}{}{:02}:{:02}",
        y,
        mo,
        d,
        h,
        mi,
        s,
        nanos / 1000,
        off_sign,
        off_h,
        off_m
    )
}

/// Local offset from UTC in seconds. Reads `/etc/localtime` indirectly by
/// asking libc via `localtime_r` would pull in libc; instead compare the
/// system's local components vs UTC by spawning `date +%z` once. We cache
/// the result for the process lifetime.
fn local_offset_seconds() -> Option<i32> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<i32>> = OnceLock::new();
    *CACHE.get_or_init(|| {
        let out = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()?;
        let s = String::from_utf8(out.stdout).ok()?;
        let s = s.trim();
        if s.len() != 5 {
            return None;
        }
        let sign = s.as_bytes()[0];
        let hh: i32 = s[1..3].parse().ok()?;
        let mm: i32 = s[3..5].parse().ok()?;
        let mag = hh * 3600 + mm * 60;
        Some(if sign == b'-' { -mag } else { mag })
    })
}

/// Civil calendar conversion (proleptic Gregorian) — Howard Hinnant's
/// algorithm. Accepts seconds since the Unix epoch and returns broken-down
/// (year, month, day, hour, minute, second). Days/seconds split is the
/// only non-trivial part; the rest is integer arithmetic.
fn ymd_hms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let h = rem / 3600;
    let mi = (rem % 3600) / 60;
    let s = rem % 60;

    // days_from_civil inverse — Hinnant.
    let z = days + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u64; // [0, 146097)
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { (mp + 3) as u32 } else { (mp - 9) as u32 };
    let y = if m <= 2 { y + 1 } else { y };

    (y as i32, m, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ymd_hms_unix_epoch() {
        assert_eq!(ymd_hms(0), (1970, 1, 1, 0, 0, 0));
    }

    #[test]
    fn ymd_hms_known_dates() {
        // 2026-04-20T12:34:56 UTC
        assert_eq!(ymd_hms(1_776_688_496), (2026, 4, 20, 12, 34, 56));
        // 2000-01-01T00:00:00 UTC
        assert_eq!(ymd_hms(946_684_800), (2000, 1, 1, 0, 0, 0));
        // 2024-02-29T00:00:00 UTC — leap-day round-trip.
        assert_eq!(ymd_hms(1_709_164_800), (2024, 2, 29, 0, 0, 0));
    }

    #[test]
    fn timestamp_has_iso8601_shape() {
        let s = timestamp();
        assert!(s.len() >= 25, "len={s:?}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }

    #[test]
    fn write_appends_line_with_expected_shape() {
        let dir = std::env::temp_dir().join(format!(
            "setpoint-guard-log-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.log");

        let r = Report {
            changed: vec!["tengu_swann_brevity".into(), "tengu_grey_step".into()],
        };
        write(&path, &r).unwrap();
        let s = std::fs::read_to_string(&path).unwrap();
        assert!(s.contains("Re-applied: tengu_swann_brevity,tengu_grey_step (2 overrides)"));
        assert!(s.ends_with('\n'));
    }

    #[test]
    fn write_skips_empty_report() {
        let dir = std::env::temp_dir().join(format!(
            "setpoint-guard-log-empty-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.log");
        write(&path, &Report::default()).unwrap();
        assert!(!path.exists(), "empty report must not create log file");
    }
}
