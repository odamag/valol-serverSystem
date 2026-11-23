//! GET /api/v1/lol/streak（LoL 戦績）。合言葉はミドルウェアで確かめる。

use axum::Json;
use axum::extract::State;
use serde_json::Value;

use crate::error::AppResult;
use crate::state::AppState;

pub async fn streak(State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.lol.get(state.clock.now()).await?))
}
