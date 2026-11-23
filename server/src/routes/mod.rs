//! ルータの組み立て。**どのパスにどのミドルウェアがかかるかは、このファイルだけで分かるようにする。**
//!
//! ## すべてのリクエストにかかるもの（外側から順に）
//!
//! 1. ログ（`TraceLayer`。パスだけを出し、クエリは出さない＝OAuth の code などを残さないため）
//! 2. タイムアウト（[`REQUEST_TIMEOUT_SECS`] 秒で 503）
//! 3. CSRF：Origin の確認（`middleware::csrf::check_origin`。GET・HEAD・OPTIONS 以外）
//! 4. 合言葉（`middleware::site_gate::require_site_pass`。例外の 3 パスを除く。
//!    `APP_SITE_GATE_ENABLED=false` なら素通り）
//! 5. ボディの大きさの上限（[`MAX_BODY_BYTES`]。超えると 413。ランニングの中継はハンドラでさらに 16 KiB に絞る）
//!
//! ## パスごとの表（URL 対応表 = 設計書 10 D6）
//!
//! | メソッド・パス                            | ハンドラ                  | 合言葉     | ログイン |
//! |-------------------------------------------|---------------------------|------------|----------|
//! | GET    /api/v1/health                     | health::health            | なし       | -        |
//! | GET    /api/v1/site/status                | site::status              | なし       | -        |
//! | POST   /api/v1/site/login                 | site::login               | なし       | -        |
//! | GET    /api/v1/auth/status                | auth::status              | ミドル     | MaybeUser |
//! | POST   /api/v1/auth/logout                | auth::logout              | ミドル     | MaybeUser |
//! | GET    /api/v1/auth/discord/start         | auth::discord_start       | ミドル     | -        |
//! | GET    /api/v1/auth/discord/callback      | auth::discord_callback    | ミドル     | -        |
//! | DELETE /api/v1/me                         | me::delete_me             | ミドル     | CurrentUser |
//! | GET    /api/v1/servers                    | servers::list             | **SitePass（必ず）** | -  |
//! | POST   /api/v1/servers/{target}/start     | servers::start            | **SitePass（必ず）** | -  |
//! | POST   /api/v1/servers/{target}/stop      | servers::stop             | **SitePass（必ず）** | -  |
//! | GET    /api/v1/lol/streak                 | lol::streak               | ミドル     | -        |
//! | *      /api/v1/running/{*rest}            | running::relay            | ミドル     | CurrentUser |
//!
//! - 「ミドル」= 上の 4 のミドルウェアで確かめる（`APP_SITE_GATE_ENABLED=false` の間は確かめない）。
//! - 「SitePass（必ず）」= ミドルウェアに加え、ハンドラの引数の `SitePass` 抽出子で、設定にかかわらず確かめる（D2）。
//! - 「CurrentUser」はハンドラの引数の抽出子で確かめる（無ければ 401）。「MaybeUser」は無くてもよい。
//! - 表に無いパスは 404、メソッド違いは 405（どちらも JSON）。合言葉が無ければ、その前に 401。

pub mod auth;
pub mod health;
pub mod lol;
pub mod me;
pub mod running;
pub mod servers;
pub mod site;

use std::time::Duration;

use axum::Json;
use axum::Router;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use serde_json::json;
use tower::ServiceBuilder;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::error::AppError;
use crate::middleware::csrf::check_origin;
use crate::middleware::site_gate::require_site_pass;
use crate::state::AppState;

/// 1 リクエストの上限時間（外部 API のタイムアウト 10 秒より長くしておく）
pub const REQUEST_TIMEOUT_SECS: u64 = 30;
/// リクエストのボディの上限（JSON しか受け取らないので小さくてよい）
pub const MAX_BODY_BYTES: usize = 64 * 1024;

pub fn router(state: AppState) -> Router {
    let routes = Router::new()
        // 合言葉なしで通る 3 つ（middleware::site_gate::SITE_GATE_EXEMPT_PATHS と揃える）
        .route("/api/v1/health", get(health::health))
        .route("/api/v1/site/status", get(site::status))
        .route("/api/v1/site/login", post(site::login))
        // ログイン
        .route("/api/v1/auth/status", get(auth::status))
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/auth/discord/start", get(auth::discord_start))
        .route("/api/v1/auth/discord/callback", get(auth::discord_callback))
        .route("/api/v1/me", delete(me::delete_me))
        // ゲームサーバー（ハンドラで SitePass を必ず確かめる）
        .route("/api/v1/servers", get(servers::list))
        .route("/api/v1/servers/{target}/start", post(servers::start))
        .route("/api/v1/servers/{target}/stop", post(servers::stop))
        // LoL 戦績
        .route("/api/v1/lol/streak", get(lol::streak))
        // ランニング（ホワイトリストはハンドラで確かめる）
        .route("/api/v1/running/{*rest}", any(running::relay))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed);

    // ServiceBuilder は上に書いたものほど外側になる（先に通る）
    let middleware = ServiceBuilder::new()
        .layer(TraceLayer::new_for_http().make_span_with(|req: &Request| {
            tracing::info_span!("request", method = %req.method(), path = %req.uri().path())
        }))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::SERVICE_UNAVAILABLE,
            Duration::from_secs(REQUEST_TIMEOUT_SECS),
        ))
        .layer(from_fn_with_state(state.clone(), check_origin))
        .layer(from_fn_with_state(state.clone(), require_site_pass))
        // ボディの型が変わる（Limited<Body>）ので、from_fn のミドルウェアより内側に置く
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES));

    routes.layer(middleware).with_state(state)
}

async fn not_found() -> AppError {
    AppError::NotFound
}

async fn method_not_allowed() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({ "success": false, "message": "許可されていないメソッドです" })),
    )
        .into_response()
}
