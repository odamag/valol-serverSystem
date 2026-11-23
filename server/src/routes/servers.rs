//! /api/v1/servers, /api/v1/servers/{target}/start|stop（ゲームサーバー）。
//!
//! どれも `SitePass` 抽出子を引数に置いたままにすること
//! （APP_SITE_GATE_ENABLED にかかわらず合言葉を確かめるため。D2）。
//! ログインは要らないので `CurrentUser` は使わない。

use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use crate::auth::site_pass::SitePass;
use crate::error::{AppError, AppResult};
use crate::services::game_servers::GameServerService;
use crate::state::AppState;

/// GET /api/v1/servers
pub async fn list(_: SitePass, State(state): State<AppState>) -> AppResult<Json<Value>> {
    Ok(Json(state.game_servers.status(state.clock.now()).await?))
}

/// POST /api/v1/servers/{target}/start
pub async fn start(
    _: SitePass,
    State(state): State<AppState>,
    Path(target): Path<String>,
) -> AppResult<Json<Value>> {
    if !GameServerService::is_known_target(&target) {
        return Err(AppError::NotFound);
    }
    let message = state.game_servers.start(&target, state.clock.now()).await?;
    Ok(Json(json!({ "success": true, "message": message })))
}

/// POST /api/v1/servers/{target}/stop（停止する相手はサーバー側でタグから探す。ボディは読まない）
pub async fn stop(
    _: SitePass,
    State(state): State<AppState>,
    Path(target): Path<String>,
) -> AppResult<Json<Value>> {
    if !GameServerService::is_known_target(&target) {
        return Err(AppError::NotFound);
    }
    let message = state.game_servers.stop(&target).await?;
    Ok(Json(json!({ "success": true, "message": message })))
}
