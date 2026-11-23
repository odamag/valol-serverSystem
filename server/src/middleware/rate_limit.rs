//! 合言葉の失敗回数の制限（IP ごと、メモリ上）。設計書 10 D4。
//!
//! プロセスは 1 つなので、メモリ上の表で足りる。再起動で消えるが、総当たりを
//! 遅くするのが目的なので困らない。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use axum::http::HeaderMap;

/// これより多くの IP を覚えたら、古い記録をまとめて捨てる（IP を変えながらの攻撃でメモリが増え続けないように）
const PRUNE_THRESHOLD: usize = 10_000;

/// 直近 `window_secs` 秒の失敗が `max_failures` 回に達した IP を止める（スライディングウィンドウ）。
pub struct RateLimiter {
    max_failures: u32,
    window_secs: i64,
    failures: Mutex<HashMap<String, VecDeque<i64>>>,
}

impl RateLimiter {
    /// 本番は `(10, 600)`
    pub fn new(max_failures: u32, window_secs: i64) -> Self {
        Self {
            max_failures,
            window_secs,
            failures: Mutex::new(HashMap::new()),
        }
    }

    /// この IP が今止められているか
    pub fn is_blocked(&self, ip: &str, now: i64) -> bool {
        let map = self.lock();
        let Some(times) = map.get(ip) else {
            return false;
        };
        let recent = times
            .iter()
            .filter(|&&t| t > now - self.window_secs)
            .count();
        recent >= self.max_failures as usize
    }

    /// この IP の失敗を 1 回記録する
    pub fn record_failure(&self, ip: &str, now: i64) {
        let mut map = self.lock();
        if map.len() >= PRUNE_THRESHOLD {
            let window = self.window_secs;
            map.retain(|_, times| times.back().is_some_and(|&t| t > now - window));
        }
        let times = map.entry(ip.to_owned()).or_default();
        while times.front().is_some_and(|&t| t <= now - self.window_secs) {
            times.pop_front();
        }
        times.push_back(now);
        // 上限を超えた分は判定に要らないので、覚えておく数を抑える
        while times.len() > self.max_failures as usize {
            times.pop_front();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<i64>>> {
        // 中で panic しても表が壊れるわけではないので、毒は無視して使い続ける
        self.failures.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 接続元の IP。Caddy が付ける `X-Forwarded-For` の一番右（＝Caddy が見た接続元）を使う。
/// 左側は利用者が自由に書けるので信用しない。無ければ "unknown"。
///
/// 前提：Rust は 127.0.0.1 で待ち受け、Caddy からしか届かない（11 §2）。
pub fn client_ip(headers: &HeaderMap) -> String {
    headers
        .get_all("x-forwarded-for")
        .iter()
        .next_back()
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| "unknown".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_max_failures_and_recovers_after_window() {
        let rl = RateLimiter::new(10, 600);
        let t0 = 1_000_000;
        for i in 0..9 {
            rl.record_failure("1.2.3.4", t0 + i);
            assert!(
                !rl.is_blocked("1.2.3.4", t0 + i),
                "{} 回目で止まった",
                i + 1
            );
        }
        rl.record_failure("1.2.3.4", t0 + 9);
        assert!(rl.is_blocked("1.2.3.4", t0 + 9));
        // ほかの IP には影響しない
        assert!(!rl.is_blocked("5.6.7.8", t0 + 9));
        // 最初の失敗から 600 秒たつと、窓から 1 回分外れて戻る
        assert!(rl.is_blocked("1.2.3.4", t0 + 599));
        assert!(!rl.is_blocked("1.2.3.4", t0 + 600));
        // 全部が窓の外に出れば完全に戻る
        assert!(!rl.is_blocked("1.2.3.4", t0 + 9 + 600));
    }

    #[test]
    fn old_failures_do_not_count() {
        let rl = RateLimiter::new(3, 600);
        rl.record_failure("ip", 0);
        rl.record_failure("ip", 1);
        rl.record_failure("ip", 1000);
        assert!(!rl.is_blocked("ip", 1000));
    }

    #[test]
    fn client_ip_uses_rightmost() {
        let mut h = HeaderMap::new();
        assert_eq!(client_ip(&h), "unknown");
        h.insert("x-forwarded-for", "9.9.9.9, 1.2.3.4".parse().unwrap());
        assert_eq!(client_ip(&h), "1.2.3.4");
        h.insert("x-forwarded-for", "  5.6.7.8 ".parse().unwrap());
        assert_eq!(client_ip(&h), "5.6.7.8");
        h.insert("x-forwarded-for", "1.1.1.1,".parse().unwrap());
        assert_eq!(client_ip(&h), "unknown");
        // ヘッダが複数あるときは最後のものの一番右
        let mut h = HeaderMap::new();
        h.append("x-forwarded-for", "9.9.9.9".parse().unwrap());
        h.append("x-forwarded-for", "8.8.8.8, 2.2.2.2".parse().unwrap());
        assert_eq!(client_ip(&h), "2.2.2.2");
    }
}
