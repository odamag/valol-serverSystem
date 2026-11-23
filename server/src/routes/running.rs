//! /api/v1/running/*（ランニングの中継）。
//!
//! ルータは `/api/v1/running/{*rest}` をすべてのメソッドでここに渡すので、
//! ホワイトリスト（メソッドが違えば 405、パスが無ければ 404）はこのハンドラで確かめる。
//! 「ログイン確認 → Discord ID（セッションの値）→ 署名 → 転送」だけをする（旧 api/running/index.php と同じ）。

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde_json::json;

use crate::auth::session::CurrentUser;
use crate::error::AppError;
use crate::services::running_relay::RunningRelay;
use crate::state::AppState;

/// ランニングの API の入口（この接頭辞を `/v1` に置き換えて転送する）
const PUBLIC_PREFIX: &str = "/api/v1/running";
/// 転送するボディの上限（画像は S3 に直接送るので、ここに大きなボディは来ない）
pub const MAX_RELAY_BODY_BYTES: usize = 16 * 1024;

fn json_error(status: StatusCode, message: &str) -> Response {
    (
        status,
        Json(json!({ "success": false, "message": message })),
    )
        .into_response()
}

/// 「2026-03-05_」＋ 32 桁の小文字 hex の記録 ID か
fn is_record_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 + 1 + 32 {
        return false;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    digits(0..4)
        && b[4] == b'-'
        && digits(5..7)
        && b[7] == b'-'
        && digits(8..10)
        && b[10] == b'_'
        && b[11..]
            .iter()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c))
}

/// ホワイトリストの結果
#[derive(Debug, PartialEq, Eq)]
enum Allowed {
    Ok,
    WrongMethod,
    NotFound,
}

/// `upstream_path`（例 `/v1/records`）とメソッドをホワイトリストと照合する。
/// パスは合うがメソッドだけ違えば 405、パスが合わなければ 404。
/// なぜ許可リストか: 無検査の丸ごと中継にすると、AWS 側に将来できる内部用のパスまで外に出てしまうため。
fn check_allowed(method: &str, upstream_path: &str) -> Allowed {
    let Some(rest) = upstream_path.strip_prefix("/v1/") else {
        return Allowed::NotFound;
    };
    let segs: Vec<&str> = rest.split('/').collect();
    let allowed: &[&str] = match segs.as_slice() {
        ["records"] => &["GET", "POST"],
        ["records", id] if is_record_id(id) => &["PATCH", "DELETE"],
        ["records", id, "photo-url"] | ["records", id, "photo"] if is_record_id(id) => &["POST"],
        ["ranking"] | ["me", "summary"] | ["settings"] => &["GET"],
        _ => return Allowed::NotFound,
    };
    if allowed.contains(&method) {
        Allowed::Ok
    } else {
        Allowed::WrongMethod
    }
}

/// /api/v1/running/{*rest}（すべてのメソッド）
pub async fn relay(
    State(state): State<AppState>,
    // Discord ID はセッションから引いた値だけを使う（クライアントが名乗れる経路を作らない）
    CurrentUser(user): CurrentUser,
    req: Request<Body>,
) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.as_str();
    let Some(sub) = parts.uri.path().strip_prefix(PUBLIC_PREFIX) else {
        return AppError::NotFound.into_response();
    };
    let upstream_path = format!("/v1{sub}");

    match check_allowed(method, &upstream_path) {
        Allowed::Ok => {}
        Allowed::WrongMethod => {
            return json_error(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        }
        Allowed::NotFound => return json_error(StatusCode::NOT_FOUND, "Not Found"),
    }

    // GET・DELETE ではボディを読まない
    let body = if method == "GET" || method == "DELETE" {
        Bytes::new()
    } else {
        match to_bytes(body, MAX_RELAY_BODY_BYTES).await {
            Ok(b) => b,
            Err(_) => {
                return json_error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "リクエストボディが大きすぎます",
                );
            }
        }
    };

    // クエリは受け取ったままの文字列で署名し、同じ文字列で転送する
    let raw_query = parts.uri.query().unwrap_or("");
    let relay: &RunningRelay = &state.running;
    let result = relay
        .forward(
            method,
            &upstream_path,
            raw_query,
            &user.discord_id,
            body,
            state.clock.now(),
        )
        .await;

    let (status, bytes) = match result {
        Ok(v) => v,
        Err(AppError::Upstream(e)) => {
            tracing::error!(
                error = format!("{e:#}"),
                "ランニングサーバーに接続できません"
            );
            return json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ランニングサーバーに接続できませんでした。しばらくしてからお試しください",
            );
        }
        Err(e) => return e.into_response(),
    };

    // AWS 側も { success, message } 形式で返す規約。success を含む JSON でなければ想定外の応答として 502
    let is_expected = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|v| v.as_object().map(|o| o.contains_key("success")))
        .unwrap_or(false);
    if !is_expected {
        let head: String = String::from_utf8_lossy(&bytes).chars().take(500).collect();
        tracing::error!(
            status = status.as_u16(),
            body = head,
            "上流の応答が想定外です"
        );
        return json_error(StatusCode::BAD_GATEWAY, "サーバーエラーが発生しました");
    }

    (status, [(header::CONTENT_TYPE, "application/json")], bytes).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "2026-03-05_0123456789abcdef0123456789abcdef";

    #[test]
    fn whitelist() {
        assert_eq!(check_allowed("GET", "/v1/records"), Allowed::Ok);
        assert_eq!(check_allowed("POST", "/v1/records"), Allowed::Ok);
        assert_eq!(check_allowed("DELETE", "/v1/records"), Allowed::WrongMethod);
        assert_eq!(
            check_allowed("PATCH", &format!("/v1/records/{ID}")),
            Allowed::Ok
        );
        assert_eq!(
            check_allowed("DELETE", &format!("/v1/records/{ID}")),
            Allowed::Ok
        );
        assert_eq!(
            check_allowed("GET", &format!("/v1/records/{ID}")),
            Allowed::WrongMethod
        );
        assert_eq!(
            check_allowed("POST", &format!("/v1/records/{ID}/photo-url")),
            Allowed::Ok
        );
        assert_eq!(
            check_allowed("POST", &format!("/v1/records/{ID}/photo")),
            Allowed::Ok
        );
        assert_eq!(check_allowed("GET", "/v1/ranking"), Allowed::Ok);
        assert_eq!(check_allowed("GET", "/v1/me/summary"), Allowed::Ok);
        assert_eq!(check_allowed("GET", "/v1/settings"), Allowed::Ok);
        assert_eq!(check_allowed("POST", "/v1/settings"), Allowed::WrongMethod);
        // ID の形が違う・大文字 hex・末尾の余分
        assert_eq!(check_allowed("PATCH", "/v1/records/abc"), Allowed::NotFound);
        assert_eq!(
            check_allowed(
                "PATCH",
                "/v1/records/2026-03-05_0123456789ABCDEF0123456789abcdef"
            ),
            Allowed::NotFound
        );
        assert_eq!(check_allowed("GET", "/v1/records/"), Allowed::NotFound);
        assert_eq!(check_allowed("GET", "/v1/admin"), Allowed::NotFound);
        assert_eq!(check_allowed("GET", "/v1/settings/"), Allowed::NotFound);
        assert_eq!(check_allowed("GET", "/v2/settings"), Allowed::NotFound);
    }
}
