//! /api/v1/auth/status, /api/v1/auth/logout, /api/v1/auth/discord/*（ログイン）。設計書 10 §4・D3。
//!
//! Discord ログインの流れ:
//! 1. `discord_start`：state（乱数）を `oauth_state` Cookie に入れ、Discord の認可画面へ 302。
//! 2. `discord_callback`：state を Cookie と定数時間で照合 → Cookie を消す → code をトークンに換える
//!    → @me → ギルドのメンバー確認 → users を upsert → セッションを作り `sid` を付けて `/server` へ 302。
//!
//! 失敗したら `/login?discord_error=<理由>` へ 302（理由は [`DiscordError`]）。
//! コールバックは GET なので Origin の確認（CSRF）は効かない。そのかわり state で守る（§5）。

use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;
use subtle::ConstantTimeEq;

use crate::auth::session::{self, MaybeUser, SESSION_COOKIE, clear_session_cookie, session_cookie};
use crate::auth::token::new_token;
use crate::auth::{build_cookie, cookie_value, removal_cookie};
use crate::error::AppResult;
use crate::state::AppState;

/// Discord ログインの途中だけ使う Cookie
pub const OAUTH_STATE_COOKIE: &str = "oauth_state";
/// `oauth_state` の Path（start と callback にだけ送られるようにする）
pub const OAUTH_STATE_PATH: &str = "/api/v1/auth/discord";
/// `oauth_state` の寿命（10 分。過ぎるとブラウザが送らなくなり invalid_state になる）
pub const OAUTH_STATE_TTL_SECS: i64 = 600;

/// ログインできたあとに戻す先
pub const LOGIN_SUCCESS_PATH: &str = "/server";

/// `/login?discord_error=<理由>` の理由（設計書 10 §4。フロントの Login.jsx が文言に変える）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiscordError {
    /// state が無い・違う・期限切れ（Cookie が 10 分で消えるため、期限切れもこれになる）
    InvalidState,
    /// 利用者が Discord の画面で拒否した（code が無いときもこれ）
    Denied,
    TokenExchangeFailed,
    /// @me かメンバー確認の呼び出しが失敗した
    UserFetchFailed,
    /// ギルドのメンバーではない（D3）
    NotMember,
    DbError,
}

impl DiscordError {
    pub fn as_str(self) -> &'static str {
        match self {
            DiscordError::InvalidState => "invalid_state",
            DiscordError::Denied => "denied",
            DiscordError::TokenExchangeFailed => "token_exchange_failed",
            DiscordError::UserFetchFailed => "user_fetch_failed",
            DiscordError::NotMember => "not_member",
            DiscordError::DbError => "db_error",
        }
    }
}

/// GET /api/v1/auth/status → {"loggedIn","userId","username"}（今の status.php と同じ形）
pub async fn status(MaybeUser(user): MaybeUser) -> Json<serde_json::Value> {
    Json(match user {
        Some(u) => json!({ "loggedIn": true, "userId": u.user_id, "username": u.display_name }),
        None => json!({ "loggedIn": false, "userId": null, "username": null }),
    })
}

/// POST /api/v1/auth/logout：そのセッションの行を消し、`sid` Cookie を空にする。
/// ログインしていなくても成功を返す（何度押しても同じ結果になるように）。
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    if let Some(token) = cookie_value(&headers, SESSION_COOKIE) {
        session::delete_session(&state.db, &token).await?;
    }
    let jar = CookieJar::new().add(clear_session_cookie(&state.config));
    Ok((jar, Json(json!({ "success": true }))).into_response())
}

/// GET /api/v1/auth/discord/start：Discord の認可画面へ 302。
pub async fn discord_start(State(state): State<AppState>) -> Response {
    let oauth_state = new_token();
    let jar = CookieJar::new().add(build_cookie(
        OAUTH_STATE_COOKIE,
        &oauth_state,
        OAUTH_STATE_PATH,
        Some(OAUTH_STATE_TTL_SECS),
        &state.config,
    ));
    redirect(&state.discord.authorize_url(&oauth_state), jar)
}

#[derive(Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// GET /api/v1/auth/discord/callback?code&state（拒否されたときは ?error&state）。
pub async fn discord_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    params: Result<Query<CallbackParams>, QueryRejection>,
) -> Response {
    // oauth_state は 1 回しか使わない。成功でも失敗でも必ず消す
    let mut jar = CookieJar::new().add(removal_cookie(
        OAUTH_STATE_COOKIE,
        OAUTH_STATE_PATH,
        &state.config,
    ));
    match login_with_discord(&state, &headers, params).await {
        Ok(token) => {
            // 前のセッションが残っていれば消す（同じブラウザに使われない行を残さないため）
            if let Some(old) = cookie_value(&headers, SESSION_COOKIE)
                && let Err(e) = session::delete_session(&state.db, &old).await
            {
                tracing::warn!(error = %e, "前のセッションを消せませんでした");
            }
            jar = jar.add(session_cookie(&token, &state.config));
            redirect(LOGIN_SUCCESS_PATH, jar)
        }
        Err(reason) => {
            tracing::info!(reason = reason.as_str(), "Discord ログインに失敗しました");
            redirect(&format!("/login?discord_error={}", reason.as_str()), jar)
        }
    }
}

/// コールバックの本体。成功したら新しいセッションのトークン（`sid` の値）を返す。
async fn login_with_discord(
    state: &AppState,
    headers: &HeaderMap,
    params: Result<Query<CallbackParams>, QueryRejection>,
) -> Result<String, DiscordError> {
    // クエリが読めない（同じキーが 2 つある等）ときは、正しい戻り方ではないので state 違いとみなす
    let Ok(Query(params)) = params else {
        return Err(DiscordError::InvalidState);
    };

    // 1. state の照合（拒否されたときも Discord は state を付けて戻すので、先に確かめる）
    let expected = cookie_value(headers, OAUTH_STATE_COOKIE).unwrap_or_default();
    let got = params.state.unwrap_or_default();
    if !state_matches(&expected, &got) {
        return Err(DiscordError::InvalidState);
    }

    // 2. 拒否・code なし
    if params.error.is_some() {
        return Err(DiscordError::Denied);
    }
    let Some(code) = params.code.filter(|c| !c.is_empty()) else {
        return Err(DiscordError::Denied);
    };

    // 3. Discord の呼び出し
    let access_token = state.discord.exchange_code(&code).await.map_err(|e| {
        tracing::warn!(
            error = format!("{e:#}"),
            "Discord のトークン交換に失敗しました"
        );
        DiscordError::TokenExchangeFailed
    })?;
    let me = state.discord.fetch_me(&access_token).await.map_err(|e| {
        tracing::warn!(
            error = format!("{e:#}"),
            "Discord のユーザー情報の取得に失敗しました"
        );
        DiscordError::UserFetchFailed
    })?;
    let is_member = state
        .discord
        .is_guild_member(&access_token)
        .await
        .map_err(|e| {
            tracing::warn!(
                error = format!("{e:#}"),
                "ギルドのメンバー確認に失敗しました"
            );
            DiscordError::UserFetchFailed
        })?;
    if !is_member {
        return Err(DiscordError::NotMember);
    }

    // 4. users の upsert とセッション
    let now = state.clock.now();
    let db_err = |e: crate::error::AppError| {
        tracing::error!(error = %e, "Discord ログインの DB 処理に失敗しました");
        DiscordError::DbError
    };
    let user_id = upsert_user(&state.db, &me.id, &me.display_name(), now)
        .await
        .map_err(db_err)?;
    session::create_session(&state.db, user_id, now)
        .await
        .map_err(db_err)
}

/// state を定数時間で比べる（Cookie の値を 1 文字ずつ当てられないように）。
/// どちらかが空なら一致とみなさない（Cookie も state も無い、で通らないように）。
fn state_matches(expected: &str, got: &str) -> bool {
    if expected.is_empty() || got.is_empty() {
        return false;
    }
    // 長さが違うときは即 false になるが、長さは秘密ではない（43 文字固定）ので問題ない
    expected.as_bytes().ct_eq(got.as_bytes()).into()
}

/// users を discord_id で upsert し、users.id を返す。
/// あれば display_name と last_login_at を更新し、無ければ作る（1 文で行うので競合しない）。
pub async fn upsert_user(
    db: &SqlitePool,
    discord_id: &str,
    display_name: &str,
    now: i64,
) -> AppResult<i64> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users (discord_id, display_name, created_at, last_login_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(discord_id) DO UPDATE
            SET display_name = excluded.display_name,
                last_login_at = excluded.last_login_at
         RETURNING id",
    )
    .bind(discord_id)
    .bind(display_name)
    .bind(now)
    .bind(now)
    .fetch_one(db)
    .await?;
    Ok(id)
}

/// 302 Found（設計書 §4 のとおり。axum の `Redirect::to` は 303 なので使わない）
fn redirect(location: &str, jar: CookieJar) -> Response {
    (StatusCode::FOUND, [(LOCATION, location.to_owned())], jar).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_compare() {
        assert!(state_matches("abc", "abc"));
        assert!(!state_matches("abc", "abd"));
        assert!(!state_matches("abc", "ab"));
        assert!(!state_matches("", ""));
        assert!(!state_matches("abc", ""));
    }
}
