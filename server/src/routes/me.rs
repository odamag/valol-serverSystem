//! DELETE /api/v1/me（アカウント削除）。
//!
//! 【仮】T13 が中身を作る。

use axum::response::Response;

use super::not_implemented;

/// DELETE /api/v1/me。【仮】
pub async fn delete_me() -> Response {
    not_implemented()
}
