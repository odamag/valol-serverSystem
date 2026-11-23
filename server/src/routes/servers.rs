//! /api/v1/servers, /api/v1/servers/{target}/start|stop（ゲームサーバー）。
//!
//! 【仮】T14 が中身を作る。どれも `SitePass` 抽出子を引数に置いたままにすること
//! （APP_SITE_GATE_ENABLED にかかわらず合言葉を確かめるため。D2）。

use axum::response::Response;

use super::not_implemented;
use crate::auth::site_pass::SitePass;

/// GET /api/v1/servers。【仮】
pub async fn list(_: SitePass) -> Response {
    not_implemented()
}

/// POST /api/v1/servers/{target}/start。【仮】
pub async fn start(_: SitePass) -> Response {
    not_implemented()
}

/// POST /api/v1/servers/{target}/stop。【仮】
pub async fn stop(_: SitePass) -> Response {
    not_implemented()
}
