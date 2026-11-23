//! ログインセッション（設計書 10 §4）。
//!
//! Cookie `sid` に乱数トークンを入れ、DB の `sessions` には SHA-256 だけを保存する。
//! 最後に使ってから 30 日で切れる。`last_seen_at` の更新は 1 時間に 1 回まで（書き込みを減らすため）。

use std::convert::Infallible;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::Cookie;
use sqlx::SqlitePool;

use crate::auth::token::{hash_token, new_token};
use crate::auth::{build_cookie, cookie_value, removal_cookie};
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "sid";
pub const SESSION_TTL_SECS: i64 = 30 * 86_400;
pub const SESSION_TOUCH_INTERVAL_SECS: i64 = 3_600;

/// ログインしている人
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionUser {
    pub user_id: i64,
    pub discord_id: String,
    pub display_name: String,
}

/// セッションを作り、生のトークン（Cookie に入れる値）を返す。
pub async fn create_session(db: &SqlitePool, user_id: i64, now: i64) -> AppResult<String> {
    let token = new_token();
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .bind(hash_token(&token))
    .bind(user_id)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(token)
}

/// トークンからログインしている人を探す。無い・期限切れなら None。
/// 最後の更新から 1 時間以上たっていれば `last_seen_at` を今にする（期限が延びる）。
pub async fn find_session_user(
    db: &SqlitePool,
    token: &str,
    now: i64,
) -> AppResult<Option<SessionUser>> {
    if token.is_empty() {
        return Ok(None);
    }
    let hash = hash_token(token);
    let row: Option<(i64, i64, String, String)> = sqlx::query_as(
        "SELECT s.last_seen_at, u.id, u.discord_id, u.display_name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(db)
    .await?;
    let Some((last_seen_at, user_id, discord_id, display_name)) = row else {
        return Ok(None);
    };
    if now >= last_seen_at + SESSION_TTL_SECS {
        // 期限切れの行は 1 時間ごとの掃除でも消えるが、見つけたらその場で消しておく
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
            .bind(&hash)
            .execute(db)
            .await?;
        return Ok(None);
    }
    if now - last_seen_at >= SESSION_TOUCH_INTERVAL_SECS {
        sqlx::query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
            .bind(now)
            .bind(&hash)
            .execute(db)
            .await?;
    }
    Ok(Some(SessionUser {
        user_id,
        discord_id,
        display_name,
    }))
}

/// セッションを消す（ログアウト）。無くてもエラーにしない。
pub async fn delete_session(db: &SqlitePool, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(hash_token(token))
        .execute(db)
        .await?;
    Ok(())
}

/// 期限切れのセッションを消し、消した数を返す（`serve` が 1 時間ごとに呼ぶ）。
pub async fn purge_expired_sessions(db: &SqlitePool, now: i64) -> AppResult<u64> {
    let r = sqlx::query("DELETE FROM sessions WHERE last_seen_at <= ?")
        .bind(now - SESSION_TTL_SECS)
        .execute(db)
        .await?;
    Ok(r.rows_affected())
}

/// `sid` Cookie。Max-Age は 30 日（ブラウザを閉じても消えないようにするため）。
pub fn session_cookie(token: &str, config: &Config) -> Cookie<'static> {
    build_cookie(SESSION_COOKIE, token, "/", Some(SESSION_TTL_SECS), config)
}

/// `sid` Cookie を消すための Cookie（ログアウト・アカウント削除で返す）。
pub fn clear_session_cookie(config: &Config) -> Cookie<'static> {
    removal_cookie(SESSION_COOKIE, "/", config)
}

/// ログイン必須のハンドラの引数に置く。無ければ 401「認証が必要です」。
pub struct CurrentUser(pub SessionUser);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, AppError> {
        let Some(token) = cookie_value(&parts.headers, SESSION_COOKIE) else {
            return Err(AppError::LoginRequired);
        };
        match find_session_user(&state.db, &token, state.clock.now()).await? {
            Some(user) => Ok(CurrentUser(user)),
            None => Err(AppError::LoginRequired),
        }
    }
}

/// ログインしていてもいなくてもよいハンドラの引数に置く（例：`/auth/status`）。失敗しない。
pub struct MaybeUser(pub Option<SessionUser>);

impl FromRequestParts<AppState> for MaybeUser {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Infallible> {
        let Some(token) = cookie_value(&parts.headers, SESSION_COOKIE) else {
            return Ok(MaybeUser(None));
        };
        match find_session_user(&state.db, &token, state.clock.now()).await {
            Ok(user) => Ok(MaybeUser(user)),
            Err(e) => {
                // DB の失敗は「ログインしていない」とみなす（このあと必要なら利用者がやり直せる）
                tracing::error!(error = %e, "セッションの確認に失敗しました");
                Ok(MaybeUser(None))
            }
        }
    }
}
