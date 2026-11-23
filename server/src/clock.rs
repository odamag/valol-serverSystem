//! 時刻の取り出し口。
//!
//! 期限切れのテストで時刻を自由に動かせるよう、コードは必ず `state.clock.now()` から
//! 時刻を取る（`SystemTime::now()` を直接呼ばない）。単位は UNIX 秒。

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// 今の時刻（UNIX 秒）
    fn now(&self) -> i64;
}

/// 本番用。OS の時計を読む。
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            // 時計が 1970 年より前を指すことは実際には無いが、panic させないため 0 にする
            .unwrap_or(0)
    }
}

/// テスト用。`set` と `advance` で時刻を動かす。
pub struct FixedClock(pub AtomicI64);

impl FixedClock {
    pub fn new(now: i64) -> Self {
        Self(AtomicI64::new(now))
    }

    /// 時刻を `now` にする
    pub fn set(&self, now: i64) {
        self.0.store(now, Ordering::SeqCst);
    }

    /// 時刻を `secs` 秒進める
    pub fn advance(&self, secs: i64) {
        self.0.fetch_add(secs, Ordering::SeqCst);
    }
}

impl Clock for FixedClock {
    fn now(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_clock_can_be_moved() {
        let c = FixedClock::new(100);
        assert_eq!(c.now(), 100);
        c.advance(50);
        assert_eq!(c.now(), 150);
        c.set(10);
        assert_eq!(c.now(), 10);
    }

    #[test]
    fn system_clock_is_after_2025() {
        assert!(SystemClock.now() > 1_735_689_600);
    }
}
