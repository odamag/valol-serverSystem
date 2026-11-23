//! ランニングの API（AWS）への中継。署名（HMAC）を付けて転送する。設計書 10 D1。
//!
//! 署名の仕様は `document/running_api.md` §2。受ける側は `aws/src/lib/verify-hmac.ts` で、
//! 1 バイトでもずれると全リクエストが 401 になる。
//! 転送先のベース URL は `config.running_api_base`（テストでは wiremock に向ける）。

use std::time::Duration;

use axum::http::StatusCode;
use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

use crate::config::Config;
use crate::error::{AppError, AppResult};

/// 署名する文字列を作る。
/// `method \n path \n query \n discordId \n ts \n nonce \n sha256hex(body)`（順序を変えてはいけない）。
pub fn canonical(
    method: &str,
    path: &str,
    query: &str,
    discord_id: &str,
    ts: &str,
    nonce: &str,
    body: &[u8],
) -> String {
    let body_hash = hex::encode(Sha256::digest(body));
    [method, path, query, discord_id, ts, nonce, &body_hash].join("\n")
}

/// HMAC-SHA256 の小文字 hex。
pub fn sign(canonical: &str, secret: &str) -> String {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(secret.as_bytes())
        .expect("HMAC は任意の長さの鍵を取れる");
    mac.update(canonical.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

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

    /// 署名を付けて転送し、上流のステータスとボディを返す。
    ///
    /// - `raw_query` は受け取ったままの文字列。署名にも URL にも同じものを使う
    ///   （AWS は `rawQueryString` で検証するので、並べ替えや再エンコードをすると 401 になる）。
    /// - 接続できない・時間切れのときは `AppError::Upstream`（呼び出し側が 503 にする）。
    pub async fn forward(
        &self,
        method: &str,
        upstream_path: &str,
        raw_query: &str,
        discord_id: &str,
        body: Bytes,
        now: i64,
    ) -> AppResult<(StatusCode, Bytes)> {
        let ts = now.to_string();
        let mut nonce_bytes = [0u8; 16];
        rand::fill(&mut nonce_bytes[..]);
        let nonce = hex::encode(nonce_bytes);

        let canon = canonical(
            method,
            upstream_path,
            raw_query,
            discord_id,
            &ts,
            &nonce,
            &body,
        );
        let signature = sign(&canon, &self.secret);

        let mut url = format!("{}{}", self.base.trim_end_matches('/'), upstream_path);
        if !raw_query.is_empty() {
            url.push('?');
            url.push_str(raw_query);
        }
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| AppError::Internal(e.into()))?;

        let res = self
            .http
            .request(method, &url)
            .header("X-Run-Discord-Id", discord_id)
            .header("X-Run-Ts", &ts)
            .header("X-Run-Nonce", &nonce)
            .header("X-Run-Signature", &signature)
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(self.timeout_secs))
            .body(body)
            .send()
            .await
            .map_err(|e| AppError::Upstream(e.into()))?;

        let status = res.status();
        let bytes = res
            .bytes()
            .await
            .map_err(|e| AppError::Upstream(e.into()))?;
        Ok((status, bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_is_lowercase_hex_64() {
        let s = sign("a", "k");
        assert_eq!(s.len(), 64);
        assert!(
            s.chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        );
    }

    #[test]
    fn canonical_empty_body_uses_sha256_of_empty() {
        let c = canonical("GET", "/v1/x", "", "1", "2", "3", b"");
        assert!(c.ends_with("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
        assert_eq!(c.matches('\n').count(), 6);
    }
}
