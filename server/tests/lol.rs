//! GET /api/v1/lol/streak の結合テスト。Riot API は wiremock で置き換える（本物は呼ばない）。

mod common;

use std::sync::Arc;

use axum::Router;
use axum::http::StatusCode;
use serde_json::{Value, json};
use tower::ServiceExt;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use common::{T0, body_json, json_request, site_pass_cookie, test_state_with};
use serversystem::build_app;
use serversystem::clock::FixedClock;
use serversystem::config::LolMember;

const ENTRIES: &str = include_str!("fixtures/lol/entries.json");

fn member(name: &str) -> LolMember {
    LolMember {
        name: name.to_owned(),
        tag: "JP1".to_owned(),
    }
}

/// 試合 1 件分の JSON（本人の puuid と、別人 1 人を含む）
fn match_json(puuid: &str, win: bool, champ: &str, end: i64) -> Value {
    json!({"info": {
        "gameEndTimestamp": end,
        "participants": [
            {"puuid": "someone-else", "win": !win, "championName": "Other", "kills": 9, "deaths": 9, "assists": 9},
            {"puuid": puuid, "win": win, "championName": champ, "kills": 4, "deaths": 5, "assists": 6},
        ],
    }})
}

/// アカウント・試合 ID・ランクを登録する。`results` は新しい順（true = 勝ち）。
/// `failing` に入れた番号（0 始まり）の試合は 500 を返す。
async fn mock_player(
    server: &MockServer,
    name: &str,
    puuid: &str,
    results: &[bool],
    failing: &[usize],
) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/riot/account/v1/accounts/by-riot-id/{name}/JP1"
        )))
        .and(header("X-Riot-Token", "RGAPI-test"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"puuid": puuid, "gameName": name, "tagLine": "JP1"})),
        )
        .mount(server)
        .await;
    let ids: Vec<String> = (0..results.len())
        .map(|i| format!("{puuid}-m{i}"))
        .collect();
    Mock::given(method("GET"))
        .and(path(format!("/lol/match/v5/matches/by-puuid/{puuid}/ids")))
        .and(query_param("type", "ranked"))
        .and(query_param("count", "20"))
        .respond_with(ResponseTemplate::new(200).set_body_json(&ids))
        .mount(server)
        .await;
    for (i, win) in results.iter().enumerate() {
        let t = if failing.contains(&i) {
            ResponseTemplate::new(500)
        } else {
            ResponseTemplate::new(200).set_body_json(match_json(
                puuid,
                *win,
                "Ahri",
                1_000 - i as i64,
            ))
        };
        Mock::given(method("GET"))
            .and(path(format!("/lol/match/v5/matches/{puuid}-m{i}")))
            .respond_with(t)
            .mount(server)
            .await;
    }
    Mock::given(method("GET"))
        .and(path(format!("/lol/league/v4/entries/by-puuid/{puuid}")))
        .respond_with(ResponseTemplate::new(200).set_body_string(ENTRIES))
        .mount(server)
        .await;
}

async fn mock_missing(server: &MockServer, name: &str) {
    Mock::given(method("GET"))
        .and(path(format!(
            "/riot/account/v1/accounts/by-riot-id/{name}/JP1"
        )))
        .respond_with(ResponseTemplate::new(404))
        .mount(server)
        .await;
}

async fn setup(server: &MockServer, members: &[&str]) -> (Router, Arc<FixedClock>, String) {
    let uri = server.uri();
    let ms: Vec<LolMember> = members.iter().map(|n| member(n)).collect();
    let (state, clock) = test_state_with(|c| {
        c.riot_account_base = uri.clone();
        c.riot_platform_base = uri;
        c.lol_members = ms;
    })
    .await;
    let pass = site_pass_cookie(&state).await;
    (build_app(state), clock, pass)
}

async fn get_streak(app: &Router, pass: &str) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(json_request("GET", "/api/v1/lol/streak", &[pass], None))
        .await
        .unwrap();
    (res.status(), body_json(res).await)
}

#[tokio::test]
async fn returns_sorted_results_with_ranks_and_not_found() {
    let server = MockServer::start().await;
    mock_missing(&server, "Ghost").await;
    mock_player(&server, "Alice", "p-alice", &[true, true, true, false], &[]).await;
    mock_player(&server, "Bob", "p-bob", &[false, false, true], &[]).await;
    mock_player(&server, "Cara", "p-cara", &[], &[]).await;
    // 設定の順は Ghost, Cara, Bob, Alice。連勝の絶対値は 0, 0, 2, 3
    let (app, _, pass) = setup(&server, &["Ghost", "Cara", "Bob", "Alice"]).await;

    let (status, body) = get_streak(&app, &pass).await;
    assert_eq!(status, StatusCode::OK);
    let arr = body.as_array().unwrap();
    let names: Vec<&str> = arr.iter().map(|p| p["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Alice", "Bob", "Ghost", "Cara"]);

    assert_eq!(arr[0]["streak"], 3);
    assert_eq!(arr[0]["lastChampion"], "Ahri");
    assert_eq!(arr[0]["lastMatchTime"], 1000);
    assert_eq!(arr[0]["recentMatches"].as_array().unwrap().len(), 4);
    assert_eq!(arr[0]["recentMatches"][0]["kills"], 4);
    assert_eq!(
        arr[0]["soloRank"],
        json!({"tier": "GOLD", "rank": "II", "lp": 50, "wins": 10, "losses": 8})
    );
    assert_eq!(arr[0]["flexRank"]["tier"], "SILVER");
    assert_eq!(arr[1]["streak"], -2);

    // アカウントが見つからない人は、soloRank・flexRank のキーが無い
    assert_eq!(
        arr[2],
        json!({"name": "Ghost", "tag": "JP1", "error": "プレイヤーが見つかりません",
               "streak": 0, "lastChampion": null, "lastMatchTime": null, "recentMatches": []})
    );
    assert!(arr[2].get("soloRank").is_none());
    assert!(arr[2].get("flexRank").is_none());

    // 試合が 0 件の人（ids が空配列 → 試合なし。ランクは付く）
    assert_eq!(arr[3]["streak"], 0);
    assert_eq!(arr[3]["lastChampion"], Value::Null);
    assert_eq!(arr[3]["recentMatches"], json!([]));
    assert!(arr[3].get("soloRank").is_some());
}

#[tokio::test]
async fn failed_match_is_skipped() {
    let server = MockServer::start().await;
    // 先頭の試合の取得が失敗 → 飛ばして 2 件目から数える
    mock_player(
        &server,
        "Alice",
        "p-alice",
        &[false, true, true, false],
        &[0],
    )
    .await;
    let (app, _, pass) = setup(&server, &["Alice"]).await;
    let (_, body) = get_streak(&app, &pass).await;
    assert_eq!(body[0]["streak"], 2);
    assert_eq!(body[0]["recentMatches"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn match_without_player_is_skipped() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/riot/account/v1/accounts/by-riot-id/Alice/JP1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({"puuid": "p-alice", "gameName": "Alice", "tagLine": "JP1"})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lol/match/v5/matches/by-puuid/p-alice/ids"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!(["x1", "x2"])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lol/match/v5/matches/x1"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(match_json("nobody", true, "Zed", 1)),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lol/match/v5/matches/x2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(match_json("p-alice", false, "Lux", 2)),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/lol/league/v4/entries/by-puuid/p-alice"))
        .respond_with(ResponseTemplate::new(404))
        .mount(&server)
        .await;
    let (app, _, pass) = setup(&server, &["Alice"]).await;
    let (_, body) = get_streak(&app, &pass).await;
    assert_eq!(body[0]["streak"], -1);
    assert_eq!(body[0]["lastChampion"], "Lux");
    // ランクが取れなければ null（キーは付く）
    assert_eq!(body[0]["soloRank"], Value::Null);
    assert_eq!(body[0]["flexRank"], Value::Null);
}

#[tokio::test]
async fn stops_fetching_once_streak_broken_and_five_collected() {
    let server = MockServer::start().await;
    // 2 件目で連勝が切れ、5 件目までで打ち切る（6 件目以降は取りに行かない）
    mock_player(
        &server,
        "Alice",
        "p-alice",
        &[true, false, true, true, true, true, true],
        &[],
    )
    .await;
    let (app, _, pass) = setup(&server, &["Alice"]).await;
    let (_, body) = get_streak(&app, &pass).await;
    assert_eq!(body[0]["streak"], 1);
    assert_eq!(body[0]["recentMatches"].as_array().unwrap().len(), 5);
    let received = server.received_requests().await.unwrap();
    assert!(
        !received
            .iter()
            .any(|r| r.url.path().ends_with("p-alice-m5"))
    );
}

#[tokio::test]
async fn cached_for_five_minutes_then_refetched() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/riot/account/v1/accounts/by-riot-id/Ghost/JP1"))
        .respond_with(ResponseTemplate::new(404))
        .expect(2)
        .mount(&server)
        .await;
    let (app, clock, pass) = setup(&server, &["Ghost"]).await;
    get_streak(&app, &pass).await;
    clock.advance(299);
    get_streak(&app, &pass).await; // キャッシュ
    clock.advance(1);
    assert_eq!(clock.0.load(std::sync::atomic::Ordering::SeqCst), T0 + 300);
    get_streak(&app, &pass).await; // 300 秒たったので取り直す
    server.verify().await;
}

#[tokio::test]
async fn concurrent_requests_call_riot_once() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/riot/account/v1/accounts/by-riot-id/Ghost/JP1"))
        .respond_with(ResponseTemplate::new(404).set_delay(std::time::Duration::from_millis(200)))
        .expect(1)
        .mount(&server)
        .await;
    let (app, _, pass) = setup(&server, &["Ghost"]).await;
    let (a, b, c) = tokio::join!(
        get_streak(&app, &pass),
        get_streak(&app, &pass),
        get_streak(&app, &pass)
    );
    assert_eq!(a.1, b.1);
    assert_eq!(b.1, c.1);
    server.verify().await;
}

#[tokio::test]
async fn requires_site_pass() {
    let server = MockServer::start().await;
    let (app, _, _) = setup(&server, &["Ghost"]).await;
    let res = app
        .oneshot(json_request("GET", "/api/v1/lol/streak", &[], None))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}
