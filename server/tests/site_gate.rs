//! ミドルウェアの結合テスト：死活確認・Origin の確認・合言葉。

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

use common::{body_json, json_request, site_pass_cookie, test_state, test_state_with};
use serversystem::auth::site_pass::SITE_PASS_TTL_SECS;
use serversystem::build_app;

#[tokio::test]
async fn health_returns_success() {
    let (state, _) = test_state().await;
    let res = build_app(state)
        .oneshot(json_request("GET", "/api/v1/health", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await, json!({"success": true}));
}

#[tokio::test]
async fn post_without_origin_is_forbidden() {
    let (state, _) = test_state().await;
    let pass = site_pass_cookie(&state).await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/logout")
        .header("cookie", &pass)
        .body(Body::empty())
        .unwrap();
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(res).await["success"], json!(false));
}

#[tokio::test]
async fn post_with_wrong_origin_is_forbidden() {
    let (state, _) = test_state().await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/site/login")
        .header("origin", "https://evil.example.com")
        .body(Body::empty())
        .unwrap();
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn post_with_referer_only_passes() {
    let (state, _) = test_state().await;
    let pass = site_pass_cookie(&state).await;
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/logout")
        .header("cookie", &pass)
        .header("referer", "https://example.com/server")
        .body(Body::empty())
        .unwrap();
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_ne!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn post_with_correct_origin_passes() {
    let (state, _) = test_state().await;
    let pass = site_pass_cookie(&state).await;
    let res = build_app(state)
        .oneshot(json_request("POST", "/api/v1/auth/logout", &[&pass], None))
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::FORBIDDEN);
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn get_without_origin_is_not_checked() {
    let (state, _) = test_state().await;
    let req = Request::builder()
        .uri("/api/v1/health")
        .body(Body::empty())
        .unwrap();
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn gate_enabled_rejects_requests_without_site_pass() {
    let (state, _) = test_state().await;
    let app = build_app(state);
    for (method, uri) in [
        ("GET", "/api/v1/servers"),
        ("GET", "/api/v1/auth/status"),
        ("GET", "/api/v1/lol/streak"),
        ("GET", "/api/v1/running/settings"),
        ("DELETE", "/api/v1/me"),
        // 表に無いパスも、合言葉が無ければ 404 より先に 401
        ("GET", "/api/v1/no-such-path"),
    ] {
        let res = app
            .clone()
            .oneshot(json_request(method, uri, &[], None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(
            body_json(res).await,
            json!({"success": false, "message": "サイト認証が必要です"})
        );
    }
}

#[tokio::test]
async fn gate_enabled_rejects_unknown_or_expired_site_pass() {
    let (state, clock) = test_state().await;
    let pass = site_pass_cookie(&state).await;
    let app = build_app(state);

    let res = app
        .clone()
        .oneshot(json_request(
            "GET",
            "/api/v1/no-such-path",
            &["site_pass=forged"],
            None,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // 有効な合言葉なら通る（表に無いパスなので 404）
    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/no-such-path", &[&pass], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);

    clock.advance(SITE_PASS_TTL_SECS);
    let res = app
        .oneshot(json_request("GET", "/api/v1/no-such-path", &[&pass], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn gate_enabled_lets_exempt_paths_through() {
    let (state, _) = test_state().await;
    let app = build_app(state);

    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/health", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/site/status", &[], None))
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);

    // 空の合言葉（正しい合言葉でも間違いでもない）で、ミドルウェアに止められないことだけを見る
    let res = app
        .oneshot(json_request(
            "POST",
            "/api/v1/site/login",
            &[],
            Some(json!({"password": ""})),
        ))
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
    assert_ne!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn gate_disabled_lets_everything_through() {
    let (state, _) = test_state_with(|c| c.site_gate_enabled = false).await;
    let app = build_app(state);
    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/no-such-path", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        body_json(res).await,
        json!({"success": false, "message": "見つかりません"})
    );

    let res = app
        .oneshot(json_request("GET", "/api/v1/auth/status", &[], None))
        .await
        .unwrap();
    assert_ne!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_method_is_405_json() {
    let (state, _) = test_state().await;
    let res = build_app(state)
        .oneshot(json_request("POST", "/api/v1/health", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(body_json(res).await["success"], json!(false));
}

#[tokio::test]
async fn placeholder_routes_are_registered() {
    // URL 対応表の新しいパスが全部登録されていること（404 / 405 にならない）
    let (state, _) = test_state_with(|c| c.site_gate_enabled = false).await;
    let app = build_app(state);
    for (method, uri) in [
        ("GET", "/api/v1/site/status"),
        ("POST", "/api/v1/site/login"),
        ("GET", "/api/v1/auth/status"),
        ("POST", "/api/v1/auth/logout"),
        ("GET", "/api/v1/auth/discord/start"),
        ("GET", "/api/v1/auth/discord/callback"),
        ("DELETE", "/api/v1/me"),
        ("GET", "/api/v1/servers"),
        ("POST", "/api/v1/servers/minecraft/start"),
        ("POST", "/api/v1/servers/minecraft/stop"),
        ("GET", "/api/v1/lol/streak"),
        ("GET", "/api/v1/running/settings"),
        (
            "PATCH",
            "/api/v1/running/records/2026-01-01_0123456789abcdef0123456789abcdef",
        ),
    ] {
        let res = app
            .clone()
            .oneshot(json_request(method, uri, &[], Some(json!({}))))
            .await
            .unwrap();
        assert_ne!(
            res.status(),
            StatusCode::METHOD_NOT_ALLOWED,
            "{method} {uri}"
        );
        // running はホワイトリスト外を 404 にするが、ここに並べたものはホワイトリストの中
        assert_ne!(res.status(), StatusCode::NOT_FOUND, "{method} {uri}");
    }
}

#[tokio::test]
async fn servers_require_site_pass_even_when_gate_disabled() {
    // D2：ゲームサーバーの操作は、合言葉のミドルウェアを切っていても SitePass で必ず確かめる
    let (state, _) = test_state_with(|c| c.site_gate_enabled = false).await;
    let pass = site_pass_cookie(&state).await;
    let app = build_app(state);
    for (method, uri) in [
        ("GET", "/api/v1/servers"),
        ("POST", "/api/v1/servers/minecraft/start"),
        ("POST", "/api/v1/servers/minecraft/stop"),
    ] {
        let res = app
            .clone()
            .oneshot(json_request(method, uri, &[], None))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED, "{method} {uri}");
        assert_eq!(
            body_json(res).await,
            json!({"success": false, "message": "サイト認証が必要です"})
        );

        let res = app
            .clone()
            .oneshot(json_request(method, uri, &[pass.as_str()], None))
            .await
            .unwrap();
        assert_ne!(res.status(), StatusCode::UNAUTHORIZED, "{method} {uri}");
    }
}
