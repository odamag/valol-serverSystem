//! GET /api/v1/lol/streak（LoL 戦績）。
//!
//! 【仮】T10 が中身を作る。

use axum::response::Response;

use super::not_implemented;

/// GET /api/v1/lol/streak。【仮】
pub async fn streak() -> Response {
    not_implemented()
}
