//! Discord ログイン・ログイン状態・ログアウト・アカウント削除のテスト（設計書 10 §4・D3）。
//! Discord は wiremock で偽物を立てる（本物は呼ばない）。

mod common;

use axum::http::StatusCode;
use axum::response::Response;
use serde_json::json;
use tower::ServiceExt;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{
    body_json, create_user, json_request, login_cookie, set_cookies, site_pass_cookie,
    test_state_with,
};
use serversystem::AppState;
use serversystem::build_app;
use serversystem::clock::FixedClock;

const GUILD: &str = "000000000000000001";
const CODE: &str = "good-code";
const ACCESS: &str = "access-token-1";

/// Discord の偽物と、それに向けた AppState
async fn setup() -> (MockServer, AppState, std::sync::Arc<FixedClock>) {
    let server = MockServer::start().await;
    let (state, clock) = test_state_with(|c| c.discord_api_base = server.uri()).await;
    (server, state, clock)
}

async fn mock_token_ok(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/oauth2/token"))
        .and(body_string_contains(format!("code={CODE}")))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains("client_secret=test-client-secret"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "access_token": ACCESS, "token_type": "Bearer" })),
        )
        .mount(server)
        .await;
}

async fn mock_me(server: &MockServer, id: &str, username: &str, global: Option<&str>) {
    Mock::given(method("GET"))
        .and(path("/users/@me"))
        .and(header("authorization", format!("Bearer {ACCESS}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": id, "username": username, "global_name": global
        })))
        .mount(server)
        .await;
}

async fn mock_member(server: &MockServer, status: u16) {
    Mock::given(method("GET"))
        .and(path(format!("/users/@me/guilds/{GUILD}/member")))
        .and(header("authorization", format!("Bearer {ACCESS}").as_str()))
        .respond_with(ResponseTemplate::new(status).set_body_json(json!({})))
        .mount(server)
        .await;
}

/// Discord の呼び出しが全部うまくいく偽物
async fn mock_all_ok(server: &MockServer, id: &str, username: &str, global: Option<&str>) {
    mock_token_ok(server).await;
    mock_me(server, id, username, global).await;
    mock_member(server, 200).await;
}

async fn send(state: &AppState, req: axum::http::Request<axum::body::Body>) -> Response {
    build_app(state.clone()).oneshot(req).await.unwrap()
}

fn location(res: &Response) -> String {
    res.headers()
        .get("location")
        .expect("Location")
        .to_str()
        .unwrap()
        .to_owned()
}

/// `Set-Cookie: name=value; ...` の value
fn cookie_val(set_cookie: &str) -> String {
    let first = set_cookie.split(';').next().unwrap();
    first.split_once('=').unwrap().1.to_owned()
}

/// start を叩いて、Discord に渡した state と `oauth_state` Cookie（"oauth_state=..."）を返す
async fn start(state: &AppState, site: &str) -> (String, String) {
    let res = send(
        state,
        json_request("GET", "/api/v1/auth/discord/start", &[site], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let url = reqwest::Url::parse(&location(&res)).unwrap();
    let st = url
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .expect("state");
    let cookies = set_cookies(&res, "oauth_state");
    assert_eq!(cookies.len(), 1);
    assert_eq!(cookie_val(&cookies[0]), st);
    (st.clone(), format!("oauth_state={st}"))
}

async fn callback(state: &AppState, cookies: &[&str], query: &str) -> Response {
    send(
        state,
        json_request(
            "GET",
            &format!("/api/v1/auth/discord/callback?{query}"),
            cookies,
            None,
        ),
    )
    .await
}

/// コールバックが失敗して /login?discord_error=<reason> に戻り、sid が付かず、oauth_state が消えること
fn assert_error_redirect(res: &Response, reason: &str) {
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(location(res), format!("/login?discord_error={reason}"));
    assert!(set_cookies(res, "sid").is_empty());
    let st = set_cookies(res, "oauth_state");
    assert_eq!(st.len(), 1);
    assert!(st[0].contains("Max-Age=0"));
}

async fn user_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap()
}

async fn session_count(state: &AppState) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn start_redirects_to_discord_with_state_cookie() {
    let (server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/discord/start", &[&site], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FOUND);
    let url = reqwest::Url::parse(&location(&res)).unwrap();
    assert!(
        url.as_str()
            .starts_with(&format!("{}/oauth2/authorize?", server.uri()))
    );
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(q["scope"], "identify guilds.members.read");
    assert_eq!(q["prompt"], "none");
    assert_eq!(q["client_id"], "test-client-id");
    assert_eq!(q["state"].len(), 43);

    let c = &set_cookies(&res, "oauth_state")[0];
    for attr in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/api/v1/auth/discord",
        "Max-Age=600",
    ] {
        assert!(c.contains(attr), "{attr} が無い: {c}");
    }
}

#[tokio::test]
async fn start_needs_site_pass() {
    let (_server, state, _) = setup().await;
    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/discord/start", &[], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_success_sets_sid_and_creates_user() {
    let (server, state, clock) = setup().await;
    mock_all_ok(&server, "123456789", "taro", Some("たろう")).await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;

    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}&state={st}")).await;
    assert_eq!(res.status(), StatusCode::FOUND);
    assert_eq!(location(&res), "/server");
    let sid = set_cookies(&res, "sid");
    assert_eq!(sid.len(), 1);
    for attr in ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"] {
        assert!(sid[0].contains(attr), "{attr} が無い: {}", sid[0]);
    }
    // oauth_state は使い終わったので消す
    assert!(set_cookies(&res, "oauth_state")[0].contains("Max-Age=0"));

    let row: (String, String, i64, i64) =
        sqlx::query_as("SELECT discord_id, display_name, created_at, last_login_at FROM users")
            .fetch_one(&state.db)
            .await
            .unwrap();
    use serversystem::clock::Clock;
    let now = clock.now();
    assert_eq!(row, ("123456789".into(), "たろう".into(), now, now));

    // 付いた sid でログイン状態が分かる
    let sid_cookie = format!("sid={}", cookie_val(&sid[0]));
    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/status", &[&site, &sid_cookie], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let uid: i64 = sqlx::query_scalar("SELECT id FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(
        body_json(res).await,
        json!({ "loggedIn": true, "userId": uid, "username": "たろう" })
    );
}

#[tokio::test]
async fn second_login_updates_display_name_and_last_login() {
    let (server, state, clock) = setup().await;
    let site = site_pass_cookie(&state).await;
    let uid = create_user(&state, "123456789", "古い名前").await;
    mock_all_ok(&server, "123456789", "taro", None).await;
    clock.advance(86_400);

    let (st, oauth) = start(&state, &site).await;
    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}&state={st}")).await;
    assert_eq!(location(&res), "/server");

    let row: (i64, String, i64, i64) =
        sqlx::query_as("SELECT id, display_name, created_at, last_login_at FROM users")
            .fetch_one(&state.db)
            .await
            .unwrap();
    // 同じ行（id は変わらない）。global_name が無いので username になる。created_at はそのまま
    assert_eq!(row, (uid, "taro".into(), common::T0, common::T0 + 86_400));
    assert_eq!(user_count(&state).await, 1);
}

#[tokio::test]
async fn login_replaces_previous_session_of_same_browser() {
    let (server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let uid = create_user(&state, "123456789", "たろう").await;
    let old = login_cookie(&state, uid).await;
    mock_all_ok(&server, "123456789", "taro", Some("たろう")).await;

    let (st, oauth) = start(&state, &site).await;
    let res = callback(
        &state,
        &[&site, &oauth, &old],
        &format!("code={CODE}&state={st}"),
    )
    .await;
    assert_eq!(location(&res), "/server");
    // 古いセッションは消え、新しいものだけが残る
    assert_eq!(session_count(&state).await, 1);
}

#[tokio::test]
async fn wrong_state_is_invalid_state() {
    let (server, state, _) = setup().await;
    // state が違えば Discord を呼ばない
    Mock::given(method("POST"))
        .and(path("/oauth2/token"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&server)
        .await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;

    // 1 文字違い
    let mut wrong = st.clone();
    let last = if wrong.ends_with('A') { 'B' } else { 'A' };
    wrong.pop();
    wrong.push(last);
    let res = callback(
        &state,
        &[&site, &oauth],
        &format!("code={CODE}&state={wrong}"),
    )
    .await;
    assert_error_redirect(&res, "invalid_state");

    // state が無い
    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}")).await;
    assert_error_redirect(&res, "invalid_state");

    // 別のブラウザ（Cookie が無い）から、正しい state を持ってきた
    let res = callback(&state, &[&site], &format!("code={CODE}&state={st}")).await;
    assert_error_redirect(&res, "invalid_state");

    assert_eq!(user_count(&state).await, 0);
}

#[tokio::test]
async fn expired_state_is_invalid_state() {
    let (_server, state, clock) = setup().await;
    let site = site_pass_cookie(&state).await;
    let (st, _oauth) = start(&state, &site).await;
    // oauth_state は Max-Age=600。10 分を過ぎるとブラウザは Cookie を送らない
    clock.advance(601);
    let res = callback(&state, &[&site], &format!("code={CODE}&state={st}")).await;
    assert_error_redirect(&res, "invalid_state");
}

#[tokio::test]
async fn denied_by_user() {
    let (_server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;
    let res = callback(
        &state,
        &[&site, &oauth],
        &format!("error=access_denied&error_description=x&state={st}"),
    )
    .await;
    assert_error_redirect(&res, "denied");

    // code が無いときも denied
    let res = callback(&state, &[&site, &oauth], &format!("state={st}")).await;
    assert_error_redirect(&res, "denied");
}

#[tokio::test]
async fn token_exchange_failure() {
    let (server, state, _) = setup().await;
    Mock::given(method("POST"))
        .and(path("/oauth2/token"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({ "error": "invalid_grant" })))
        .mount(&server)
        .await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;
    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}&state={st}")).await;
    assert_error_redirect(&res, "token_exchange_failed");
}

#[tokio::test]
async fn user_fetch_failure() {
    let (server, state, _) = setup().await;
    mock_token_ok(&server).await;
    Mock::given(method("GET"))
        .and(path("/users/@me"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;
    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}&state={st}")).await;
    assert_error_redirect(&res, "user_fetch_failed");
}

#[tokio::test]
async fn not_guild_member() {
    let (server, state, _) = setup().await;
    mock_token_ok(&server).await;
    mock_me(&server, "123456789", "taro", None).await;
    mock_member(&server, 404).await;
    let site = site_pass_cookie(&state).await;
    let (st, oauth) = start(&state, &site).await;
    let res = callback(&state, &[&site, &oauth], &format!("code={CODE}&state={st}")).await;
    assert_error_redirect(&res, "not_member");
    assert_eq!(user_count(&state).await, 0);
    assert_eq!(session_count(&state).await, 0);
}

#[tokio::test]
async fn status_when_logged_out() {
    let (_server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/status", &[&site, "sid=unknown"], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await,
        json!({ "loggedIn": false, "userId": null, "username": null })
    );
}

#[tokio::test]
async fn logout_deletes_session_row() {
    let (_server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let uid = create_user(&state, "123", "たろう").await;
    let sid = login_cookie(&state, uid).await;
    let other = login_cookie(&state, uid).await;
    assert_eq!(session_count(&state).await, 2);

    let res = send(
        &state,
        json_request("POST", "/api/v1/auth/logout", &[&site, &sid], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    let cleared = set_cookies(&res, "sid");
    assert_eq!(cleared.len(), 1);
    assert!(cleared[0].starts_with("sid=;"));
    assert!(cleared[0].contains("Max-Age=0"));
    assert_eq!(body_json(res).await, json!({ "success": true }));
    // そのセッションだけが消える（ほかの端末のログインは残る）
    assert_eq!(session_count(&state).await, 1);

    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/status", &[&site, &sid], None),
    )
    .await;
    assert_eq!(body_json(res).await["loggedIn"], false);
    let res = send(
        &state,
        json_request("GET", "/api/v1/auth/status", &[&site, &other], None),
    )
    .await;
    assert_eq!(body_json(res).await["loggedIn"], true);

    // ログインしていなくても成功する
    let res = send(
        &state,
        json_request("POST", "/api/v1/auth/logout", &[&site], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn delete_me_removes_user_and_all_sessions() {
    let (_server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let uid = create_user(&state, "123", "たろう").await;
    let keep = create_user(&state, "456", "はなこ").await;
    let sid = login_cookie(&state, uid).await;
    let _other_device = login_cookie(&state, uid).await;
    let _keep_sid = login_cookie(&state, keep).await;

    let res = send(
        &state,
        json_request("DELETE", "/api/v1/me", &[&site, &sid], None),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(set_cookies(&res, "sid")[0].contains("Max-Age=0"));
    assert_eq!(body_json(res).await, json!({ "success": true }));

    let left: Vec<i64> = sqlx::query_scalar("SELECT id FROM users")
        .fetch_all(&state.db)
        .await
        .unwrap();
    assert_eq!(left, vec![keep]);
    // ON DELETE CASCADE で、その人のセッションは全部消える
    let sessions: Vec<i64> = sqlx::query_scalar("SELECT user_id FROM sessions")
        .fetch_all(&state.db)
        .await
        .unwrap();
    assert_eq!(sessions, vec![keep]);
}

#[tokio::test]
async fn delete_me_needs_login() {
    let (_server, state, _) = setup().await;
    let site = site_pass_cookie(&state).await;
    let res = send(&state, json_request("DELETE", "/api/v1/me", &[&site], None)).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
