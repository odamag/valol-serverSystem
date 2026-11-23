//! テストの補助（設計書 10 §6.7）。
//!
//! 使い方：各テストファイルの先頭に `mod common;` を書く。
//! 使わない関数があっても警告にならないよう、`#![allow(dead_code)]` にしてある
//! （tests/ のファイルはそれぞれ別のクレートとしてビルドされるため）。

#![allow(dead_code)]

use std::sync::Arc;

use axum::body::Body;
use axum::http::Request;
use axum::response::Response;
use http_body_util::BodyExt;

use serversystem::AppState;
use serversystem::auth::{session, site_pass};
use serversystem::clock::FixedClock;
use serversystem::config::Config;
use serversystem::db;
use serversystem::services::game_servers::UnconfiguredBackend;

/// テストの始まりの時刻（2026-01-01 00:00:00 UTC）
pub const T0: i64 = 1_767_225_600;

/// `json_request` が付ける Origin（`Config::for_test().public_origin` と同じ）
pub const TEST_ORIGIN: &str = "https://example.com";

/// メモリ上の SQLite（マイグレーション済み）、時刻は [`T0`] で固定、設定は `Config::for_test()`。
///
/// - 設定を変えたいときは、`test_state_with(|c| c.site_gate_enabled = false)` を使う。
/// - 外部 URL は空。wiremock を使うときは `test_state_with(|c| c.riot_account_base = server.uri())`。
/// - ゲームサーバーの EC2 は仮のもの。偽物を使うときは
///   `state.game_servers = Arc::new(GameServerService::new(Arc::new(偽物), &state.config));`
pub async fn test_state() -> (AppState, Arc<FixedClock>) {
    test_state_with(|_| {}).await
}

/// 設定を書き換えてから組み立てる版
pub async fn test_state_with(edit: impl FnOnce(&mut Config)) -> (AppState, Arc<FixedClock>) {
    let mut config = Config::for_test();
    edit(&mut config);
    let pool = db::connect_in_memory().await.expect("メモリ上の DB");
    db::migrate(&pool).await.expect("マイグレーション");
    let clock = Arc::new(FixedClock::new(T0));
    let state = AppState::new(config, pool, clock.clone(), Arc::new(UnconfiguredBackend))
        .expect("AppState");
    (state, clock)
}

/// users に 1 行作り、id を返す。
pub async fn create_user(state: &AppState, discord_id: &str, name: &str) -> i64 {
    let now = state.clock.now();
    let r = sqlx::query(
        "INSERT INTO users (discord_id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)",
    )
    .bind(discord_id)
    .bind(name)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .expect("users に追加");
    r.last_insert_rowid()
}

/// ログインセッションを作り、`"sid=..."` を返す（Cookie ヘッダにそのまま使える）。
pub async fn login_cookie(state: &AppState, user_id: i64) -> String {
    let token = session::create_session(&state.db, user_id, state.clock.now())
        .await
        .expect("セッション作成");
    format!("{}={token}", session::SESSION_COOKIE)
}

/// 合言葉を通った記録を作り、`"site_pass=..."` を返す。
pub async fn site_pass_cookie(state: &AppState) -> String {
    let token = site_pass::create_site_pass(&state.db, "Test Device", state.clock.now())
        .await
        .expect("合言葉の記録作成");
    format!("{}={token}", site_pass::SITE_PASS_COOKIE)
}

/// リクエストを作る。Origin（[`TEST_ORIGIN`]）を自動で付ける。
/// `cookies` は `login_cookie` などの戻り値をそのまま並べる。`body` があれば JSON で送る。
pub fn json_request(
    method: &str,
    uri: &str,
    cookies: &[&str],
    body: Option<serde_json::Value>,
) -> Request<Body> {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("origin", TEST_ORIGIN);
    if !cookies.is_empty() {
        b = b.header("cookie", cookies.join("; "));
    }
    match body {
        Some(v) => b
            .header("content-type", "application/json")
            .body(Body::from(v.to_string()))
            .expect("リクエスト"),
        None => b.body(Body::empty()).expect("リクエスト"),
    }
}

/// 応答のボディを JSON として読む（テストの確認用）。
pub async fn body_json(res: Response) -> serde_json::Value {
    let bytes = res.into_body().collect().await.expect("ボディ").to_bytes();
    serde_json::from_slice(&bytes).expect("JSON")
}

/// 応答の `Set-Cookie` から、名前が `name` のものを全部取り出す（属性つきの生の文字列）。
pub fn set_cookies(res: &Response, name: &str) -> Vec<String> {
    let prefix = format!("{name}=");
    res.headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter(|v| v.starts_with(&prefix))
        .map(str::to_owned)
        .collect()
}
