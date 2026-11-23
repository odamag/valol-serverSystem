//! DELETE /api/v1/me（アカウント削除）。設計書 10 §4・D5。

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde_json::json;

use crate::auth::session::{CurrentUser, clear_session_cookie};
use crate::error::AppResult;
use crate::state::AppState;

/// DELETE /api/v1/me：users の行を消し、`sid` Cookie を空にする。
/// セッションは外部キーの `ON DELETE CASCADE` で一緒に消える（ほかの端末のログインも切れる）。
pub async fn delete_me(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> AppResult<Response> {
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(user.user_id)
        .execute(&state.db)
        .await?;
    let jar = CookieJar::new().add(clear_session_cookie(&state.config));
    Ok((jar, Json(json!({ "success": true }))).into_response())
}
