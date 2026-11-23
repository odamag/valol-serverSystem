//! 合言葉（/api/v1/site/status, /api/v1/site/login）の結合テスト。

mod common;

use axum::http::StatusCode;
use serde_json::json;
use tower::ServiceExt;

use common::{body_json, json_request, set_cookies, test_state_with};
use serversystem::build_app;

/// PHP の password_hash が作った `$2y$` のハッシュ（README.md 参照）
const PHP_HASH: &str = include_str!("fixtures/site/hash.txt");
const PHP_PASSWORD: &str = "テスト用合言葉";

fn login_req(password: &str) -> axum::http::Request<axum::body::Body> {
    json_request(
        "POST",
        "/api/v1/site/login",
        &[],
        Some(json!({ "password": password })),
    )
}

async fn state() -> serversystem::state::AppState {
    let (state, _) = test_state_with(|c| c.site_password_hash = PHP_HASH.trim().to_owned()).await;
    state
}

#[test]
fn php_hash_verifies_with_bcrypt() {
    let hash = PHP_HASH.trim();
    assert!(hash.starts_with("$2y$"));
    assert!(bcrypt::verify(PHP_PASSWORD, hash).unwrap());
    assert!(!bcrypt::verify("ちがう", hash).unwrap());
}

#[tokio::test]
async fn correct_password_sets_cookie_and_status_becomes_true() {
    let app = build_app(state().await);

    let res = app.clone().oneshot(login_req(PHP_PASSWORD)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookies = set_cookies(&res, "site_pass");
    assert_eq!(cookies.len(), 1);
    assert!(cookies[0].contains("HttpOnly"));
    assert!(cookies[0].contains("Max-Age=2592000"));
    assert_eq!(body_json(res).await, json!({"success": true}));

    // Set-Cookie の "name=value" の部分だけを次のリクエストに付ける
    let pair = cookies[0].split(';').next().unwrap().to_owned();
    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/site/status", &[&pair], None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await, json!({"authenticated": true}));

    let res = app
        .oneshot(json_request("GET", "/api/v1/site/status", &[], None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await, json!({"authenticated": false}));
}

#[tokio::test]
async fn wrong_password_is_401() {
    let app = build_app(state().await);
    let res = app.oneshot(login_req("まちがい")).await.unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(set_cookies(&res, "site_pass").is_empty());
    assert_eq!(
        body_json(res).await,
        json!({"success": false, "message": "パスワードが正しくありません"})
    );
}

#[tokio::test]
async fn empty_or_malformed_body_is_400() {
    let app = build_app(state().await);
    for req in [
        login_req(""),
        json_request("POST", "/api/v1/site/login", &[], Some(json!({}))),
        json_request("POST", "/api/v1/site/login", &[], None),
    ] {
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(res).await,
            json!({"success": false, "message": "パスワードを入力してください"})
        );
    }
}

#[tokio::test]
async fn eleventh_attempt_is_429_even_with_correct_password() {
    let app = build_app(state().await);
    for _ in 0..10 {
        let res = app.clone().oneshot(login_req("まちがい")).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
    let res = app.clone().oneshot(login_req(PHP_PASSWORD)).await.unwrap();
    assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(set_cookies(&res, "site_pass").is_empty());
}

#[tokio::test]
async fn empty_password_does_not_count_as_failure() {
    let app = build_app(state().await);
    for _ in 0..15 {
        let res = app.clone().oneshot(login_req("")).await.unwrap();
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
    }
    let res = app.oneshot(login_req(PHP_PASSWORD)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}
