//! GET /api/v1/health：死活確認（デプロイの確認に使う）。合言葉なしで通る。

use axum::Json;
use serde_json::{Value, json};

pub async fn health() -> Json<Value> {
    Json(json!({ "success": true }))
}
