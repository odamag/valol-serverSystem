//! /api/v1/site/status, /api/v1/site/login（サイト合言葉）。
//!
//! 合言葉は bcrypt のハッシュ（`SITE_PASSWORD_HASH`）と照合する。通ったら `site_pass` Cookie を出す。
//! 総当たりを遅くするため、失敗は IP ごとに数えて、10 分で 10 回に達したら 429 にする（D4）。

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum_extra::extract::cookie::CookieJar;
use serde_json::json;

use crate::auth::site_pass::{
    create_site_pass, device_name_from_ua, has_valid_site_pass, site_pass_cookie,
};
use crate::error::{AppError, AppResult};
use crate::middleware::rate_limit::client_ip;
use crate::state::AppState;

/// GET /api/v1/site/status → {"authenticated": bool}
pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let authenticated = has_valid_site_pass(&state, &headers).await?;
    Ok(Json(json!({ "authenticated": authenticated })).into_response())
}

/// POST /api/v1/site/login {password}
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    // 形の違う本文でも axum 独自の文面にせず、「空」と同じに扱う
    let password = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("password")
                .and_then(|p| p.as_str().map(str::to_owned))
        })
        .unwrap_or_default();
    if password.is_empty() {
        return Err(AppError::BadRequest(
            "パスワードを入力してください".to_owned(),
        ));
    }

    let now = state.clock.now();
    let ip = client_ip(&headers);
    if state.site_login_limiter.is_blocked(&ip, now) {
        return Err(AppError::TooManyRequests);
    }

    // bcrypt は重い計算なので、他のリクエストを止めないよう専用のスレッドで流す
    let hash = state.config.site_password_hash.clone();
    let ok = tokio::task::spawn_blocking(move || bcrypt::verify(password, &hash))
        .await
        .map_err(|e| AppError::Internal(e.into()))?
        .map_err(|e| {
            AppError::Internal(anyhow::Error::new(e).context("合言葉のハッシュを読めません"))
        })?;

    if !ok {
        state.site_login_limiter.record_failure(&ip, now);
        // AppError に「間違い」用の種類は無いので、ここで直接作る
        let body = json!({"success": false, "message": "パスワードが正しくありません"});
        return Ok((StatusCode::UNAUTHORIZED, Json(body)).into_response());
    }

    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let token = create_site_pass(&state.db, device_name_from_ua(ua), now).await?;
    let jar = CookieJar::new().add(site_pass_cookie(&token, &state.config));
    Ok((jar, Json(json!({ "success": true }))).into_response())
}
