//! サイト合言葉の Cookie（設計書 10 D4・§4）。
//!
//! 合言葉を通ると `site_pass` Cookie（32 バイトの乱数）を出し、DB の `site_passes` には
//! SHA-256 だけを保存する。最後に使ってから 30 日で切れる。

use axum::extract::FromRequestParts;
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum_extra::extract::cookie::Cookie;
use sqlx::SqlitePool;

use crate::auth::token::{hash_token, new_token};
use crate::auth::{build_cookie, cookie_value};
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const SITE_PASS_COOKIE: &str = "site_pass";
pub const SITE_PASS_TTL_SECS: i64 = 30 * 86_400;
/// `last_used_at` の更新は 1 時間に 1 回まで（全 API で確かめるので、毎回書くと書き込みが多すぎる）
pub const SITE_PASS_TOUCH_INTERVAL_SECS: i64 = 3_600;

/// 合言葉を通った記録を作り、生のトークン（Cookie に入れる値）を返す。
pub async fn create_site_pass(db: &SqlitePool, device_name: &str, now: i64) -> AppResult<String> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO site_passes (token_hash, device_name, created_at, last_used_at) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(device_name)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(token)
}

/// トークンが有効か。有効で、最後の更新から 1 時間以上たっていれば `last_used_at` を今にする。
pub async fn check_site_pass(db: &SqlitePool, token: &str, now: i64) -> AppResult<bool> {
    if token.is_empty() {
        return Ok(false);
    }
    let hash = hash_token(token);
    let last_used_at: Option<i64> =
        sqlx::query_scalar("SELECT last_used_at FROM site_passes WHERE token_hash = ?")
            .bind(&hash)
            .fetch_optional(db)
            .await?;
    let Some(last_used_at) = last_used_at else {
        return Ok(false);
    };
    if now >= last_used_at + SITE_PASS_TTL_SECS {
        return Ok(false);
    }
    if now - last_used_at >= SITE_PASS_TOUCH_INTERVAL_SECS {
        sqlx::query("UPDATE site_passes SET last_used_at = ? WHERE token_hash = ?")
            .bind(now)
            .bind(&hash)
            .execute(db)
            .await?;
    }
    Ok(true)
}

/// 期限切れの記録を消し、消した数を返す（`serve` が 1 時間ごとに呼ぶ）。
pub async fn purge_expired_site_passes(db: &SqlitePool, now: i64) -> AppResult<u64> {
    let r = sqlx::query("DELETE FROM site_passes WHERE last_used_at <= ?")
        .bind(now - SITE_PASS_TTL_SECS)
        .execute(db)
        .await?;
    Ok(r.rows_affected())
}

/// `site_pass` Cookie。Max-Age は 30 日（ブラウザを閉じても合言葉を入れ直さずに済むように）。
pub fn site_pass_cookie(token: &str, config: &Config) -> Cookie<'static> {
    build_cookie(
        SITE_PASS_COOKIE,
        token,
        "/",
        Some(SITE_PASS_TTL_SECS),
        config,
    )
}

/// 今の PHP の deviceNameFromUA と同じ分け方（上から順に当てはめる）。
pub fn device_name_from_ua(ua: &str) -> &'static str {
    if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Windows") {
        "Windows PC"
    } else if ua.contains("Linux") {
        "Linux PC"
    } else {
        "Unknown Device"
    }
}

/// ミドルウェア（`require_site_pass`）が確かめ済みであることの印。
/// リクエストの extensions に入れる。外からは入れられない（ヘッダではないため）。
#[derive(Clone, Copy, Debug)]
pub(crate) struct SitePassVerified;

/// リクエストの Cookie に有効な `site_pass` があるか。
pub async fn has_valid_site_pass(state: &AppState, headers: &HeaderMap) -> AppResult<bool> {
    match cookie_value(headers, SITE_PASS_COOKIE) {
        Some(token) => check_site_pass(&state.db, &token, state.clock.now()).await,
        None => Ok(false),
    }
}

/// 合言葉が必ず要るハンドラ（ゲームサーバーの操作）の引数に置く。
/// `APP_SITE_GATE_ENABLED` にかかわらず確かめ、無ければ 401「サイト認証が必要です」（D2）。
pub struct SitePass;

impl FromRequestParts<AppState> for SitePass {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        // ミドルウェアで確かめ済みなら、同じ確認を 2 回しない
        if parts.extensions.get::<SitePassVerified>().is_some() {
            return Ok(SitePass);
        }
        if has_valid_site_pass(state, &parts.headers).await? {
            Ok(SitePass)
        } else {
            Err(AppError::SiteAuthRequired)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_names_match_php() {
        let cases = [
            (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
                "iPhone",
            ),
            ("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad"),
            ("Mozilla/5.0 (Linux; Android 14; Pixel 8)", "Android"),
            ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Mac"),
            ("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Windows PC"),
            ("Mozilla/5.0 (X11; Linux x86_64)", "Linux PC"),
            ("curl/8.0", "Unknown Device"),
            ("", "Unknown Device"),
        ];
        for (ua, want) in cases {
            assert_eq!(device_name_from_ua(ua), want, "{ua}");
        }
    }
}
