//! /api/v1/site/status, /api/v1/site/login（サイト合言葉）。
//!
//! 【仮】T12 が中身を作る。

use axum::response::Response;

use super::not_implemented;

/// GET /api/v1/site/status → {"authenticated": bool}。【仮】
pub async fn status() -> Response {
    not_implemented()
}

/// POST /api/v1/site/login {password}。【仮】
pub async fn login() -> Response {
    not_implemented()
}
