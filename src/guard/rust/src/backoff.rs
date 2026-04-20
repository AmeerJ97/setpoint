//! Exponential backoff for revert storms.
//!
//! When the same flag is reverted ≥ THRESHOLD times within WINDOW seconds,
//! we suspend its category for SUSPEND seconds and surface an anomaly. This
//! prevents the guard from fighting Anthropic in a tight loop — if the
//! server-side flag is genuinely changing, our overrides land, get reverted
//! within milliseconds, and re-fire on the next inotify event. That kind of
//! ping-pong is wasted work and indicates upstream divergence, not normal
//! operation.
//!
//! Tracking is per *flag name* (the dotted path like `tengu_pewter_kestrel.Bash`),
//! not per category, so a single noisy subkey doesn't suspend its whole
//! category. The suspension *is* applied at the category level since that's
//! the user-facing surface.

use std::collections::HashMap;
use std::time::{Duration, Instant};

const THRESHOLD: usize = 3;
const WINDOW_SECS: u64 = 60;
const SUSPEND_SECS: u64 = 5 * 60;

/// Maps flag-or-category-name → Vec<timestamp of revert observed>.
/// Keep the Vec small by trimming entries older than WINDOW on every push.
pub struct Backoff {
    reverts: HashMap<String, Vec<Instant>>,
    suspended_until: HashMap<String, Instant>,
}

#[derive(Debug, PartialEq)]
pub struct StormDetected {
    pub key: String,
    pub recent_count: usize,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            reverts: HashMap::new(),
            suspended_until: HashMap::new(),
        }
    }

    /// Record a revert and return Some(StormDetected) iff this push crossed
    /// the threshold. Caller is responsible for translating the dotted flag
    /// name to a category name when calling `suspend`.
    pub fn record(&mut self, key: &str, now: Instant) -> Option<StormDetected> {
        let window = Duration::from_secs(WINDOW_SECS);
        let entry = self.reverts.entry(key.to_string()).or_default();
        entry.retain(|t| now.duration_since(*t) <= window);
        entry.push(now);
        if entry.len() >= THRESHOLD {
            Some(StormDetected {
                key: key.to_string(),
                recent_count: entry.len(),
            })
        } else {
            None
        }
    }

    /// Suspend a category for SUSPEND_SECS from `now`.
    pub fn suspend(&mut self, category: &str, now: Instant) {
        self.suspended_until
            .insert(category.to_string(), now + Duration::from_secs(SUSPEND_SECS));
    }

    /// True if `category` is currently suspended at `now`. Lazily evicts
    /// expired entries so the map doesn't grow unbounded.
    pub fn is_suspended(&mut self, category: &str, now: Instant) -> bool {
        if let Some(deadline) = self.suspended_until.get(category) {
            if now < *deadline {
                return true;
            }
            self.suspended_until.remove(category);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_threshold_no_storm() {
        let mut b = Backoff::new();
        let t0 = Instant::now();
        assert_eq!(b.record("flag", t0), None);
        assert_eq!(b.record("flag", t0 + Duration::from_secs(1)), None);
    }

    #[test]
    fn third_revert_within_window_triggers_storm() {
        let mut b = Backoff::new();
        let t0 = Instant::now();
        b.record("flag", t0);
        b.record("flag", t0 + Duration::from_secs(10));
        let storm = b.record("flag", t0 + Duration::from_secs(20));
        assert!(storm.is_some());
        assert_eq!(storm.unwrap().recent_count, 3);
    }

    #[test]
    fn old_reverts_outside_window_are_dropped() {
        let mut b = Backoff::new();
        let t0 = Instant::now();
        b.record("flag", t0);
        b.record("flag", t0 + Duration::from_secs(10));
        // 90s after t0 — t0 and t0+10 are both stale.
        let r = b.record("flag", t0 + Duration::from_secs(90));
        assert!(r.is_none(), "stale reverts must not count");
    }

    #[test]
    fn suspension_lasts_5_minutes() {
        let mut b = Backoff::new();
        let t0 = Instant::now();
        b.suspend("brevity", t0);
        assert!(b.is_suspended("brevity", t0 + Duration::from_secs(60)));
        assert!(b.is_suspended("brevity", t0 + Duration::from_secs(299)));
        assert!(!b.is_suspended("brevity", t0 + Duration::from_secs(301)));
    }

    #[test]
    fn unrelated_categories_are_independent() {
        let mut b = Backoff::new();
        let t0 = Instant::now();
        b.suspend("brevity", t0);
        assert!(!b.is_suspended("quiet", t0 + Duration::from_secs(60)));
    }
}
