//! ランニングの中継（署名の一致・転送・ホワイトリスト・エラーの扱い）のテスト。

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
use tower::ServiceExt;
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{TEST_ORIGIN, body_json, create_user, json_request, login_cookie, test_state_with};
use serversystem::build_app;
use serversystem::services::running_relay::{canonical, sign};

const SECRET: &str = "test-shared-secret";
const ID: &str = "2026-03-05_0123456789abcdef0123456789abcdef";

#[test]
fn canonical_and_sign_match_fixture() {
    let text = include_str!("fixtures/running_hmac.json");
    let cases: Vec<Value> = serde_json::from_str(text).unwrap();
    assert!(cases.len() >= 5);
    for c in &cases {
        let s = |k: &str| c[k].as_str().unwrap().to_owned();
        let got = canonical(
            &s("method"),
            &s("path"),
            &s("query"),
            &s("discordId"),
            &s("ts"),
            &s("nonce"),
            s("body").as_bytes(),
        );
        assert_eq!(got, s("canonical"), "canonical: {}", s("name"));
        assert_eq!(
            sign(&got, &s("secret")),
            s("signature"),
            "signature: {}",
            s("name")
        );
    }
}

/// 上流（wiremock）に向けた状態と、ログイン済みの Cookie を作る。
async fn setup(upstream: &MockServer) -> (serversystem::AppState, String) {
    setup_base(upstream.uri()).await
}

async fn setup_base(base: String) -> (serversystem::AppState, String) {
    let (state, _) = test_state_with(|c| {
        c.site_gate_enabled = false;
        c.running_api_base = base;
        c.running_shared_secret = SECRET.to_owned();
    })
    .await;
    let uid = create_user(&state, "999000111", "たろう").await;
    let cookie = login_cookie(&state, uid).await;
    (state, cookie)
}

async fn ok_upstream() -> MockServer {
    let s = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"success": true, "x": 1})))
        .mount(&s)
        .await;
    s
}

#[tokio::test]
async fn forwards_with_signed_headers_and_same_query() {
    let up = ok_upstream().await;
    let (state, cookie) = setup(&up).await;
    // 並べ替え・再エンコードされると困る形（%エンコード、+、同じキーの繰り返し、カンマ）
    let query = "b=2&a=%E3%81%82&c=x+y&a=1,2";
    let req = json_request(
        "GET",
        &format!("/api/v1/running/records?{query}"),
        &[&cookie],
        None,
    );
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await, json!({"success": true, "x": 1}));

    let reqs = up.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 1);
    let r = &reqs[0];
    assert_eq!(r.url.path(), "/v1/records");
    // 届いたクエリ = 受け取ったクエリ
    assert_eq!(r.url.query(), Some(query));
    let h = |n: &str| r.headers.get(n).unwrap().to_str().unwrap().to_owned();
    assert_eq!(h("x-run-discord-id"), "999000111");
    assert_eq!(h("x-run-ts"), common::T0.to_string());
    assert_eq!(h("x-run-nonce").len(), 32);
    // 届いた内容から署名を作り直すと、届いた署名と一致する（署名に使ったクエリ = 届いたクエリ）
    let canon = canonical(
        "GET",
        r.url.path(),
        r.url.query().unwrap_or(""),
        &h("x-run-discord-id"),
        &h("x-run-ts"),
        &h("x-run-nonce"),
        &r.body,
    );
    assert_eq!(h("x-run-signature"), sign(&canon, SECRET));
}

#[tokio::test]
async fn forwards_post_body_and_status() {
    let up = MockServer::start().await;
    Mock::given(any())
        .respond_with(
            ResponseTemplate::new(409).set_body_json(json!({"success": false, "message": "競合"})),
        )
        .mount(&up)
        .await;
    let (state, cookie) = setup(&up).await;
    let payload = json!({"memo": "朝ラン"});
    let req = json_request(
        "PATCH",
        &format!("/api/v1/running/records/{ID}"),
        &[&cookie],
        Some(payload.clone()),
    );
    let res = build_app(state).oneshot(req).await.unwrap();
    // 上流のステータスとボディをそのまま返す
    assert_eq!(res.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(res).await["message"], "競合");

    let r = &up.received_requests().await.unwrap()[0];
    assert_eq!(r.method.as_str(), "PATCH");
    assert_eq!(r.url.path(), format!("/v1/records/{ID}"));
    assert_eq!(r.body, payload.to_string().as_bytes());
}

#[tokio::test]
async fn get_and_delete_do_not_forward_body() {
    let up = ok_upstream().await;
    let (state, cookie) = setup(&up).await;
    let req = json_request(
        "DELETE",
        &format!("/api/v1/running/records/{ID}?updatedAt=2026-03-05T06%3A00%3A00.000Z"),
        &[&cookie],
        Some(json!({"ignored": true})),
    );
    let res = build_app(state).oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let r = &up.received_requests().await.unwrap()[0];
    assert!(r.body.is_empty());
}

#[tokio::test]
async fn whitelist_404_and_405_without_calling_upstream() {
    let up = ok_upstream().await;
    let (state, cookie) = setup(&up).await;
    let app = build_app(state);
    for (method, path, status, msg) in [
        ("GET", "/api/v1/running/admin", 404, "Not Found"),
        ("GET", "/api/v1/running/records/abc", 404, "Not Found"),
        (
            "POST",
            "/api/v1/running/settings",
            405,
            "Method Not Allowed",
        ),
        ("PUT", "/api/v1/running/records", 405, "Method Not Allowed"),
    ] {
        let res = app
            .clone()
            .oneshot(json_request(method, path, &[&cookie], None))
            .await
            .unwrap();
        assert_eq!(res.status().as_u16(), status, "{method} {path}");
        assert_eq!(body_json(res).await["message"], msg);
    }
    assert!(up.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn requires_login() {
    let up = ok_upstream().await;
    let (state, _) = setup(&up).await;
    let res = build_app(state)
        .oneshot(json_request("GET", "/api/v1/running/settings", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert!(up.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn body_over_16kib_is_413() {
    let up = ok_upstream().await;
    let (state, cookie) = setup(&up).await;
    let app = build_app(state);
    let post = |len: usize| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/running/records")
            .header("origin", TEST_ORIGIN)
            .header("cookie", &cookie)
            .body(Body::from("a".repeat(len)))
            .unwrap()
    };
    let res = app.clone().oneshot(post(16 * 1024 + 1)).await.unwrap();
    assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(up.received_requests().await.unwrap().is_empty());
    // ちょうど 16 KiB は通す
    let res = app.oneshot(post(16 * 1024)).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn upstream_down_is_503() {
    // 誰も待ち受けていないポート（一度開いてすぐ閉じる）に向ける。MockServer を drop しても
    // 裏のタスクがすぐには止まらず、テストが不安定になるため
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (state, cookie) = setup_base(format!("http://127.0.0.1:{port}")).await;
    let res = build_app(state)
        .oneshot(json_request(
            "GET",
            "/api/v1/running/settings",
            &[&cookie],
            None,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body_json(res).await["message"],
        "ランニングサーバーに接続できませんでした。しばらくしてからお試しください"
    );
}

#[tokio::test]
async fn non_json_or_without_success_is_502() {
    for template in [
        ResponseTemplate::new(200).set_body_string("<html>oops</html>"),
        ResponseTemplate::new(200).set_body_json(json!({"foo": 1})),
        ResponseTemplate::new(500).set_body_json(json!([1, 2])),
    ] {
        let up = MockServer::start().await;
        Mock::given(any()).respond_with(template).mount(&up).await;
        let (state, cookie) = setup(&up).await;
        let res = build_app(state)
            .oneshot(json_request(
                "GET",
                "/api/v1/running/settings",
                &[&cookie],
                None,
            ))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(
            body_json(res).await["message"],
            "サーバーエラーが発生しました"
        );
    }
}
