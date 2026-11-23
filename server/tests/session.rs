//! ログインセッションと合言葉の Cookie、抽出子（CurrentUser・MaybeUser・SitePass）のテスト。

mod common;

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;
use serde_json::json;
use tower::ServiceExt;

use common::{
    body_json, create_user, json_request, login_cookie, site_pass_cookie, test_state,
    test_state_with,
};
use serversystem::AppState;
use serversystem::auth::session::{
    self, CurrentUser, MaybeUser, SESSION_TOUCH_INTERVAL_SECS, SESSION_TTL_SECS, SessionUser,
};
use serversystem::auth::site_pass::{self, SITE_PASS_TTL_SECS, SitePass};

async fn last_seen(state: &AppState, token: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT last_seen_at FROM sessions WHERE token_hash = ?")
        .bind(serversystem::auth::token::hash_token(token))
        .fetch_optional(&state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn session_create_find_and_delete() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let now = common::T0;
    let token = session::create_session(&state.db, uid, now).await.unwrap();

    // DB には生の値ではなくハッシュだけがある
    let raw: Option<i64> = sqlx::query_scalar("SELECT 1 FROM sessions WHERE token_hash = ?")
        .bind(token.as_bytes())
        .fetch_optional(&state.db)
        .await
        .unwrap();
    assert!(raw.is_none());

    let user = session::find_session_user(&state.db, &token, now)
        .await
        .unwrap();
    assert_eq!(
        user,
        Some(SessionUser {
            user_id: uid,
            discord_id: "111".into(),
            display_name: "たろう".into()
        })
    );
    assert_eq!(
        session::find_session_user(&state.db, "wrong", now)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        session::find_session_user(&state.db, "", now)
            .await
            .unwrap(),
        None
    );

    session::delete_session(&state.db, &token).await.unwrap();
    assert_eq!(
        session::find_session_user(&state.db, &token, now)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn session_expires_after_30_days_without_use() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let t0 = common::T0;
    let token = session::create_session(&state.db, uid, t0).await.unwrap();

    let just_before = t0 + SESSION_TTL_SECS - 1;
    assert!(
        session::find_session_user(&state.db, &token, just_before)
            .await
            .unwrap()
            .is_some()
    );
    // 使ったので期限が延びている
    assert!(
        session::find_session_user(&state.db, &token, just_before + SESSION_TTL_SECS - 1)
            .await
            .unwrap()
            .is_some()
    );
    // そこから 30 日使わないと切れる
    let expired = just_before + SESSION_TTL_SECS - 1 + SESSION_TTL_SECS;
    assert!(
        session::find_session_user(&state.db, &token, expired)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn session_expires_exactly_at_ttl() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let t0 = common::T0;
    let token = session::create_session(&state.db, uid, t0).await.unwrap();
    assert!(
        session::find_session_user(&state.db, &token, t0 + SESSION_TTL_SECS)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn last_seen_is_updated_at_most_once_an_hour() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let t0 = common::T0;
    let token = session::create_session(&state.db, uid, t0).await.unwrap();

    session::find_session_user(&state.db, &token, t0 + SESSION_TOUCH_INTERVAL_SECS - 1)
        .await
        .unwrap();
    assert_eq!(last_seen(&state, &token).await, Some(t0));

    let t1 = t0 + SESSION_TOUCH_INTERVAL_SECS;
    session::find_session_user(&state.db, &token, t1)
        .await
        .unwrap();
    assert_eq!(last_seen(&state, &token).await, Some(t1));

    session::find_session_user(&state.db, &token, t1 + 10)
        .await
        .unwrap();
    assert_eq!(last_seen(&state, &token).await, Some(t1));
}

#[tokio::test]
async fn purge_removes_only_expired_sessions() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let t0 = common::T0;
    let old = session::create_session(&state.db, uid, t0).await.unwrap();
    let new = session::create_session(&state.db, uid, t0 + 100)
        .await
        .unwrap();
    let n = session::purge_expired_sessions(&state.db, t0 + SESSION_TTL_SECS)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(last_seen(&state, &old).await.is_none());
    assert!(last_seen(&state, &new).await.is_some());
}

#[tokio::test]
async fn deleting_user_cascades_to_sessions() {
    let (state, _) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let token = session::create_session(&state.db, uid, common::T0)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(uid)
        .execute(&state.db)
        .await
        .unwrap();
    assert!(last_seen(&state, &token).await.is_none());
}

#[tokio::test]
async fn session_cookie_attributes() {
    let (state, _) = test_state().await;
    let c = session::session_cookie("abc", &state.config).to_string();
    assert!(c.starts_with("sid=abc"));
    for attr in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(c.contains(attr), "{attr} が無い: {c}");
    }
    let clear = session::clear_session_cookie(&state.config).to_string();
    assert!(clear.starts_with("sid=;"));
    assert!(clear.contains("Max-Age=0"));
}

#[tokio::test]
async fn site_pass_create_check_and_expire() {
    let (state, _) = test_state().await;
    let t0 = common::T0;
    let token = site_pass::create_site_pass(&state.db, "iPhone", t0)
        .await
        .unwrap();
    assert!(
        site_pass::check_site_pass(&state.db, &token, t0)
            .await
            .unwrap()
    );
    assert!(
        !site_pass::check_site_pass(&state.db, "forged", t0)
            .await
            .unwrap()
    );
    assert!(!site_pass::check_site_pass(&state.db, "", t0).await.unwrap());

    let device: String =
        sqlx::query_scalar("SELECT device_name FROM site_passes WHERE token_hash = ?")
            .bind(serversystem::auth::token::hash_token(&token))
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(device, "iPhone");

    // 使うと期限が延びる
    let t1 = t0 + SITE_PASS_TTL_SECS - 1;
    assert!(
        site_pass::check_site_pass(&state.db, &token, t1)
            .await
            .unwrap()
    );
    assert!(
        site_pass::check_site_pass(&state.db, &token, t1 + SITE_PASS_TTL_SECS - 1)
            .await
            .unwrap()
    );
    // 30 日使わないと切れる
    assert!(
        !site_pass::check_site_pass(&state.db, &token, t1 + 2 * SITE_PASS_TTL_SECS)
            .await
            .unwrap()
    );
    let n = site_pass::purge_expired_site_passes(&state.db, t1 + 2 * SITE_PASS_TTL_SECS)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn site_pass_cookie_attributes() {
    let (state, _) = test_state().await;
    let c = site_pass::site_pass_cookie("abc", &state.config).to_string();
    assert!(c.starts_with("site_pass=abc"));
    for attr in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=2592000",
    ] {
        assert!(c.contains(attr), "{attr} が無い: {c}");
    }
}

/// 抽出子を試すための小さなルータ（本物のルートの中身に左右されないように）
fn extractor_app(state: AppState) -> Router {
    Router::new()
        .route(
            "/me",
            get(|CurrentUser(u): CurrentUser| async move {
                axum::Json(json!({"id": u.user_id, "name": u.display_name}))
            }),
        )
        .route(
            "/maybe",
            get(|MaybeUser(u): MaybeUser| async move {
                axum::Json(json!({"loggedIn": u.is_some()}))
            }),
        )
        .route("/pass", get(|_: SitePass| async { "ok" }))
        .with_state(state)
}

#[tokio::test]
async fn current_user_and_maybe_user() {
    let (state, clock) = test_state().await;
    let uid = create_user(&state, "111", "たろう").await;
    let sid = login_cookie(&state, uid).await;
    let app = extractor_app(state);

    let res = app
        .clone()
        .oneshot(json_request("GET", "/me", &[&sid], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await, json!({"id": uid, "name": "たろう"}));

    let res = app
        .clone()
        .oneshot(json_request("GET", "/me", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        body_json(res).await,
        json!({"success": false, "message": "認証が必要です"})
    );

    let res = app
        .clone()
        .oneshot(json_request("GET", "/maybe", &[&sid], None))
        .await
        .unwrap();
    assert_eq!(body_json(res).await, json!({"loggedIn": true}));
    let res = app
        .clone()
        .oneshot(json_request("GET", "/maybe", &["sid=forged"], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body_json(res).await, json!({"loggedIn": false}));

    // 期限切れ
    clock.advance(SESSION_TTL_SECS);
    let res = app
        .oneshot(json_request("GET", "/me", &[&sid], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn site_pass_extractor_checks_even_when_gate_disabled() {
    let (state, clock) = test_state_with(|c| c.site_gate_enabled = false).await;
    let pass = site_pass_cookie(&state).await;
    let app = extractor_app(state);

    let res = app
        .clone()
        .oneshot(json_request("GET", "/pass", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        body_json(res).await,
        json!({"success": false, "message": "サイト認証が必要です"})
    );

    let res = app
        .clone()
        .oneshot(json_request("GET", "/pass", &[&pass], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    clock.advance(SITE_PASS_TTL_SECS);
    let res = app
        .oneshot(json_request("GET", "/pass", &[&pass], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
