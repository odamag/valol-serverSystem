//! ゲームサーバー API の結合テスト（設計書 12 §3.4）。EC2 は偽物に差し替える。

mod common;

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use axum::http::StatusCode;
use serde_json::{Value, json};
use tower::ServiceExt;

use common::{body_json, json_request, site_pass_cookie, test_state, test_state_with};
use serversystem::AppState;
use serversystem::build_app;
use serversystem::clock::FixedClock;
use serversystem::services::game_servers::{GameServerBackend, GameServerService, InstanceInfo};

#[derive(Default)]
struct Fake {
    instance: Mutex<Option<InstanceInfo>>,
    find_names: Mutex<Vec<String>>,
    find_calls: AtomicUsize,
    run_calls: AtomicUsize,
    run_args: Mutex<Vec<(String, String)>>,
    terminated: Mutex<Vec<String>>,
    fail_find: Mutex<bool>,
}

#[async_trait]
impl GameServerBackend for Fake {
    async fn find_instance(&self, name_tag: &str) -> anyhow::Result<Option<InstanceInfo>> {
        self.find_calls.fetch_add(1, Ordering::SeqCst);
        self.find_names.lock().unwrap().push(name_tag.to_owned());
        if *self.fail_find.lock().unwrap() {
            anyhow::bail!("AccessDenied: 秘密の AWS エラー文");
        }
        Ok(self.instance.lock().unwrap().clone())
    }
    async fn run_from_template(&self, lt: &str, name_tag: &str) -> anyhow::Result<()> {
        // 同時に来たもう 1 つの起動が割り込める余地を作る
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.run_calls.fetch_add(1, Ordering::SeqCst);
        self.run_args
            .lock()
            .unwrap()
            .push((lt.to_owned(), name_tag.to_owned()));
        Ok(())
    }
    async fn terminate(&self, instance_id: &str) -> anyhow::Result<()> {
        self.terminated.lock().unwrap().push(instance_id.to_owned());
        Ok(())
    }
}

fn inst(state: &str, game_status: Option<&str>) -> InstanceInfo {
    InstanceInfo {
        instance_id: "i-found".to_owned(),
        state: state.to_owned(),
        public_ip: Some("203.0.113.5".to_owned()),
        game_status: game_status.map(str::to_owned),
    }
}

async fn setup() -> (AppState, Arc<FixedClock>, Arc<Fake>, String) {
    let (mut state, clock) = test_state().await;
    let fake = Arc::new(Fake::default());
    state.game_servers = Arc::new(GameServerService::new(fake.clone(), &state.config));
    let pass = site_pass_cookie(&state).await;
    (state, clock, fake, pass)
}

async fn call(state: &AppState, method: &str, uri: &str, pass: &str) -> (StatusCode, Value) {
    let res = build_app(state.clone())
        .oneshot(json_request(method, uri, &[pass], None))
        .await
        .unwrap();
    (res.status(), body_json(res).await)
}

async fn display_state(state: &AppState, pass: &str) -> Value {
    let (st, v) = call(state, "GET", "/api/v1/servers", pass).await;
    assert_eq!(st, StatusCode::OK);
    v["servers"]["minecraft"]["displayState"].clone()
}

// ── displayState の表（行ごとに 1 つ） ──

#[tokio::test]
async fn display_closing_for_shutting_down_and_stopping() {
    for s in ["shutting-down", "stopping"] {
        let (state, _, fake, pass) = setup().await;
        *fake.instance.lock().unwrap() = Some(inst(s, Some("Online")));
        assert_eq!(display_state(&state, &pass).await, json!("closing"));
    }
}

#[tokio::test]
async fn display_ready_when_running_and_online() {
    let (state, _, fake, pass) = setup().await;
    *fake.instance.lock().unwrap() = Some(inst("running", Some("Online")));
    assert_eq!(display_state(&state, &pass).await, json!("ready"));
}

#[tokio::test]
async fn display_loading_when_running_but_not_online() {
    for gs in [Some("Booting"), None] {
        let (state, _, fake, pass) = setup().await;
        *fake.instance.lock().unwrap() = Some(inst("running", gs));
        assert_eq!(display_state(&state, &pass).await, json!("loading"));
    }
}

#[tokio::test]
async fn display_pending_when_instance_is_pending() {
    // 今の PHP では stopped と出ていたのを直した行
    let (state, _, fake, pass) = setup().await;
    *fake.instance.lock().unwrap() = Some(inst("pending", None));
    assert_eq!(display_state(&state, &pass).await, json!("pending"));
}

#[tokio::test]
async fn display_pending_when_not_found_within_lock() {
    let (state, clock, fake, pass) = setup().await;
    let (st, _) = call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(st, StatusCode::OK);
    clock.advance(119);
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 1);
    assert_eq!(display_state(&state, &pass).await, json!("pending"));
}

#[tokio::test]
async fn display_stopped_when_not_found_and_no_lock() {
    let (state, clock, _, pass) = setup().await;
    assert_eq!(display_state(&state, &pass).await, json!("stopped"));
    // ロックが 120 秒たって切れたあとも stopped
    let (st, _) = call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(st, StatusCode::OK);
    clock.advance(120);
    assert_eq!(display_state(&state, &pass).await, json!("stopped"));
}

#[tokio::test]
async fn status_json_has_same_shape_as_php() {
    let (state, _, fake, pass) = setup().await;
    *fake.instance.lock().unwrap() = Some(inst("running", Some("Online")));
    let (st, v) = call(&state, "GET", "/api/v1/servers", &pass).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        v,
        json!({
            "servers": {"minecraft": {
                "name": "⛏️ Minecraft", "port": 25565, "state": "running",
                "displayState": "ready", "ip": "203.0.113.5",
                "instanceId": "i-found", "gameStatus": "Online"
            }},
            "message": ""
        })
    );
    assert_eq!(fake.find_names.lock().unwrap().as_slice(), ["minecraft"]);
}

// ── 起動・停止 ──

#[tokio::test]
async fn start_uses_launch_template_and_tag() {
    let (state, _, fake, pass) = setup().await;
    let (st, v) = call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        v,
        json!({"success": true, "message": "🚀 起動リクエストを送信しました"})
    );
    assert_eq!(
        fake.run_args.lock().unwrap().as_slice(),
        [("lt-test".to_owned(), "minecraft".to_owned())]
    );
}

#[tokio::test]
async fn start_when_instance_exists_is_conflict_without_run() {
    let (state, _, fake, pass) = setup().await;
    *fake.instance.lock().unwrap() = Some(inst("running", None));
    let (st, v) = call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(
        v["message"],
        json!("⚠️ すでに起動しているか、終了処理中です。")
    );
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn second_start_within_120s_is_409_then_ok_after() {
    let (state, clock, fake, pass) = setup().await;
    let uri = "/api/v1/servers/minecraft/start";
    assert_eq!(call(&state, "POST", uri, &pass).await.0, StatusCode::OK);
    clock.advance(119);
    let (st, v) = call(&state, "POST", uri, &pass).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["message"], json!("⚠️ ⛏️ Minecraft は起動処理中です。"));
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 1);
    clock.advance(1);
    assert_eq!(call(&state, "POST", uri, &pass).await.0, StatusCode::OK);
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn concurrent_starts_run_instances_only_once() {
    let (state, _, fake, pass) = setup().await;
    let uri = "/api/v1/servers/minecraft/start";
    let (a, b) = tokio::join!(
        call(&state, "POST", uri, &pass),
        call(&state, "POST", uri, &pass)
    );
    let mut codes = [a.0, b.0];
    codes.sort();
    assert_eq!(codes, [StatusCode::OK, StatusCode::CONFLICT]);
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn stop_terminates_instance_found_by_tag_not_client_id() {
    let (state, _, fake, pass) = setup().await;
    *fake.instance.lock().unwrap() = Some(inst("running", Some("Online")));
    // クライアントが instanceId を送っても無視される
    let res = build_app(state.clone())
        .oneshot(json_request(
            "POST",
            "/api/v1/servers/minecraft/stop",
            &[&pass],
            Some(json!({"instanceId": "i-someone-else"})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        body_json(res).await,
        json!({"success": true, "message": "停止リクエストを送信しました"})
    );
    assert_eq!(fake.terminated.lock().unwrap().as_slice(), ["i-found"]);
    assert_eq!(fake.find_names.lock().unwrap().as_slice(), ["minecraft"]);
}

#[tokio::test]
async fn stop_without_instance_does_not_terminate() {
    let (state, _, fake, pass) = setup().await;
    let (st, v) = call(&state, "POST", "/api/v1/servers/minecraft/stop", &pass).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["message"], json!("⚠️ 停止するサーバーが見つかりません"));
    assert!(fake.terminated.lock().unwrap().is_empty());
}

#[tokio::test]
async fn stop_clears_start_lock_and_cache() {
    let (state, _, fake, pass) = setup().await;
    assert_eq!(
        call(&state, "POST", "/api/v1/servers/minecraft/start", &pass)
            .await
            .0,
        StatusCode::OK
    );
    *fake.instance.lock().unwrap() = Some(inst("running", None));
    assert_eq!(display_state(&state, &pass).await, json!("loading"));
    assert_eq!(
        call(&state, "POST", "/api/v1/servers/minecraft/stop", &pass)
            .await
            .0,
        StatusCode::OK
    );
    *fake.instance.lock().unwrap() = None;
    // 停止でロックもキャッシュも消えるので、すぐ stopped になる
    assert_eq!(display_state(&state, &pass).await, json!("stopped"));
}

// ── キャッシュ ──

#[tokio::test]
async fn status_is_cached_for_3_seconds_and_dropped_by_start() {
    let (state, clock, fake, pass) = setup().await;
    display_state(&state, &pass).await;
    clock.advance(2);
    display_state(&state, &pass).await;
    assert_eq!(fake.find_calls.load(Ordering::SeqCst), 1);
    clock.advance(1);
    display_state(&state, &pass).await;
    assert_eq!(fake.find_calls.load(Ordering::SeqCst), 2);

    // 起動でキャッシュが捨てられる（find は起動の確認で 1 回 + 状態で 1 回）
    call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(fake.find_calls.load(Ordering::SeqCst), 3);
    assert_eq!(display_state(&state, &pass).await, json!("pending"));
    assert_eq!(fake.find_calls.load(Ordering::SeqCst), 4);
}

// ── エラー文を出さない ──

#[tokio::test]
async fn aws_error_text_is_not_exposed() {
    let (state, _, fake, pass) = setup().await;
    *fake.fail_find.lock().unwrap() = true;
    let (st, v) = call(&state, "GET", "/api/v1/servers", &pass).await;
    assert_eq!(st, StatusCode::OK);
    assert!(!v.to_string().contains("AccessDenied"));
    assert_eq!(v["servers"]["minecraft"]["displayState"], json!("stopped"));
    assert_ne!(v["message"], json!(""));

    let (st, v) = call(&state, "POST", "/api/v1/servers/minecraft/start", &pass).await;
    assert_eq!(st, StatusCode::BAD_GATEWAY);
    assert!(!v.to_string().contains("AccessDenied"));
    // 失敗したらロックは外れ、すぐやり直せる
    *fake.fail_find.lock().unwrap() = false;
    assert_eq!(
        call(&state, "POST", "/api/v1/servers/minecraft/start", &pass)
            .await
            .0,
        StatusCode::OK
    );
}

// ── 合言葉・ターゲット ──

#[tokio::test]
async fn without_site_pass_is_401_even_when_gate_disabled() {
    for gate in [true, false] {
        let (mut state, _) = test_state_with(|c| c.site_gate_enabled = gate).await;
        state.game_servers = Arc::new(GameServerService::new(
            Arc::new(Fake::default()),
            &state.config,
        ));
        for (m, uri) in [
            ("GET", "/api/v1/servers"),
            ("POST", "/api/v1/servers/minecraft/start"),
            ("POST", "/api/v1/servers/minecraft/stop"),
        ] {
            let res = build_app(state.clone())
                .oneshot(json_request(m, uri, &[], None))
                .await
                .unwrap();
            assert_eq!(
                res.status(),
                StatusCode::UNAUTHORIZED,
                "{m} {uri} gate={gate}"
            );
        }
    }
}

#[tokio::test]
async fn site_pass_alone_without_login_is_200() {
    let (state, _, _, pass) = setup().await;
    let (st, _) = call(&state, "GET", "/api/v1/servers", &pass).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn unknown_target_is_404() {
    let (state, _, fake, pass) = setup().await;
    for action in ["start", "stop"] {
        let uri = format!("/api/v1/servers/palworld/{action}");
        assert_eq!(
            call(&state, "POST", &uri, &pass).await.0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(fake.run_calls.load(Ordering::SeqCst), 0);
    assert!(fake.terminated.lock().unwrap().is_empty());
}
