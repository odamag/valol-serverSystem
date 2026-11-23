//! サイト合言葉のミドルウェア（設計書 10 D4）。
//!
//! `/api/v1/*` のすべてに、`site_pass` Cookie が有効であることを求める（無ければ 401）。
//! 例外は [`SITE_GATE_EXEMPT_PATHS`] の 3 つだけ。`APP_SITE_GATE_ENABLED=false` なら素通り。
//! 新しいルートを足すと、何もしなくても合言葉が要る側に入る（付け忘れで穴にならないように）。
//!
//! ゲームサーバーの操作は、この設定にかかわらずハンドラの `SitePass` 抽出子で確かめる（D2）。

use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::auth::site_pass::{SitePassVerified, has_valid_site_pass};
use crate::error::AppError;
use crate::state::AppState;

/// 合言葉なしで通すパス（合言葉を入れるための 2 つと、デプロイの確認に使う死活確認）
pub const SITE_GATE_EXEMPT_PATHS: [&str; 3] = [
    "/api/v1/site/status",
    "/api/v1/site/login",
    "/api/v1/health",
];

pub async fn require_site_pass(
    State(s): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    if !s.config.site_gate_enabled || SITE_GATE_EXEMPT_PATHS.contains(&req.uri().path()) {
        return next.run(req).await;
    }
    match has_valid_site_pass(&s, req.headers()).await {
        Ok(true) => {
            // ハンドラの SitePass 抽出子が、同じ確認をもう一度しなくて済むように印を付ける
            req.extensions_mut().insert(SitePassVerified);
            next.run(req).await
        }
        Ok(false) => AppError::SiteAuthRequired.into_response(),
        Err(e) => e.into_response(),
    }
}
