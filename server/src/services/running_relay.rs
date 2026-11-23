//! ランニングの API（AWS）への中継。署名（HMAC）を付けて転送する。設計書 10 D1。
//!
//! 【仮】T16 が中身を作る。形（型と関数のシグネチャ）は設計書 10 §6.7 のとおり。
//! 転送先のベース URL は `config.running_api_base`（テストでは wiremock に向ける）。

use axum::http::StatusCode;
use bytes::Bytes;

use crate::config::Config;
use crate::error::{AppError, AppResult};

/// 署名する文字列を作る。【仮】
pub fn canonical(
    _method: &str,
    _path: &str,
    _query: &str,
    _discord_id: &str,
    _ts: &str,
    _nonce: &str,
    _body: &[u8],
) -> String {
    String::new()
}

/// HMAC-SHA256 の小文字 hex。【仮】
pub fn sign(_canonical: &str, _secret: &str) -> String {
    String::new()
}

#[allow(dead_code)] // T16 が中身を作るまでの間だけ（フィールドがまだ読まれていないため）
pub struct RunningRelay {
    http: reqwest::Client,
    base: String,
    secret: String,
    timeout_secs: u64,
}

impl RunningRelay {
    pub fn new(http: reqwest::Client, config: &Config) -> Self {
        Self {
            http,
            base: config.running_api_base.clone(),
            secret: config.running_shared_secret.clone(),
            timeout_secs: config.running_timeout_secs,
        }
    }

    /// 署名を付けて転送し、上流のステータスとボディを返す。【仮】
    pub async fn forward(
        &self,
        _method: &str,
        _upstream_path: &str,
        _raw_query: &str,
        _discord_id: &str,
        _body: Bytes,
        _now: i64,
    ) -> AppResult<(StatusCode, Bytes)> {
        Err(AppError::Internal(anyhow::anyhow!("未実装です")))
    }
}
