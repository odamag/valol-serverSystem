//! /api/v1/auth/status, /api/v1/auth/logout, /api/v1/auth/discord/*（ログイン）。
//!
//! 【仮】T13 が中身を作る。

use axum::response::Response;

use super::not_implemented;

/// GET /api/v1/auth/status → {"loggedIn","userId","username"}。【仮】
pub async fn status() -> Response {
    not_implemented()
}

/// POST /api/v1/auth/logout。【仮】
pub async fn logout() -> Response {
    not_implemented()
}

/// GET /api/v1/auth/discord/start：Discord の認可画面へ 302。【仮】
pub async fn discord_start() -> Response {
    not_implemented()
}

/// GET /api/v1/auth/discord/callback?code&state。【仮】
pub async fn discord_callback() -> Response {
    not_implemented()
}
