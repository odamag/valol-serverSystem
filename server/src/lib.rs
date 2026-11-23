//! serverSystem の API サーバー（Rust）。設計書は document/renewal/10_architecture.md。
//!
//! 結合テスト（`tests/`）から使えるよう、組み立ては [`build_app`] で公開する。

pub mod auth;
pub mod cli;
pub mod clock;
pub mod config;
pub mod db;
pub mod error;
pub mod middleware;
pub mod routes;
pub mod services;
pub mod state;

pub use state::AppState;

/// ミドルウェアとルートを全部つないだもの。中身は `routes/mod.rs` を見る。
pub fn build_app(state: AppState) -> axum::Router {
    routes::router(state)
}
