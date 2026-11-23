//! LoL 戦績（Riot API の呼び出しと連勝の計算）。
//!
//! 今の `api/lol/streak.php` と同じ配列を返す。
//! - 計算は純粋関数（[`summarize`]・[`sort_results`]・[`parse_ranks`]）に分けてあり、HTTP を使わずにテストできる。
//! - 外部 API のベース URL は `config.riot_account_base` / `config.riot_platform_base`（テストで差し替える）。
//! - 結果は 5 分間メモリに持つ。期限が切れたとき、同時に来たリクエストが Riot API を何度も
//!   呼ばないよう、取得中は `tokio::sync::Mutex` を持ったままにして 1 つずつ通す。

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::config::{Config, LolMember};
use crate::error::AppResult;

/// キャッシュの有効秒数（PHP の `$cacheTTL` と同じ）
pub const CACHE_TTL_SECS: i64 = 300;
/// 直近の試合として返す件数
const RECENT_COUNT: usize = 5;
/// 試合 ID を取る件数
const MATCH_ID_COUNT: &str = "20";

/// 試合 1 件のうち、計算に使う部分
#[derive(Clone, Debug, PartialEq)]
pub struct Match {
    pub participants: Vec<Participant>,
    /// `info.gameEndTimestamp`（ミリ秒。無ければ None）
    pub game_end_timestamp: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Participant {
    pub puuid: String,
    pub win: bool,
    pub champion_name: String,
    pub kills: i64,
    pub deaths: i64,
    pub assists: i64,
}

/// 1 人分の連勝・連敗の集計
#[derive(Clone, Debug, PartialEq)]
pub struct StreakSummary {
    /// 正なら連勝、負なら連敗（例: -3 は 3 連敗）、0 は試合なし
    pub streak: i64,
    pub last_champion: Option<String>,
    pub last_match_time: Option<i64>,
    pub recent_matches: Vec<Value>,
}

impl StreakSummary {
    fn empty() -> Self {
        Self {
            streak: 0,
            last_champion: None,
            last_match_time: None,
            recent_matches: Vec::new(),
        }
    }
}

/// 新しい順に試合を 1 件ずつ受け取って集計する入れ物。
/// 「連勝が切れて直近 5 件も揃ったらやめる」を、API を呼ぶ側が `is_done` で知れるよう、
/// summarize とは別に取り出してある（無駄な API 呼び出しを減らすため）。
#[derive(Debug)]
pub struct StreakAccumulator {
    puuid: String,
    summary: StreakSummary,
    first_result: Option<bool>,
    broken: bool,
}

impl StreakAccumulator {
    pub fn new(puuid: &str) -> Self {
        Self {
            puuid: puuid.to_owned(),
            summary: StreakSummary::empty(),
            first_result: None,
            broken: false,
        }
    }

    /// 試合を 1 件足す。本人が参加していない試合は飛ばす。
    pub fn push(&mut self, m: &Match) {
        let Some(p) = m.participants.iter().find(|p| p.puuid == self.puuid) else {
            return;
        };
        let won = p.win;
        match self.first_result {
            None => {
                self.first_result = Some(won);
                self.summary.last_champion = Some(p.champion_name.clone());
                self.summary.last_match_time = m.game_end_timestamp;
                self.summary.streak = if won { 1 } else { -1 };
            }
            Some(first) if !self.broken => {
                if won == first {
                    self.summary.streak += if won { 1 } else { -1 };
                } else {
                    self.broken = true;
                }
            }
            Some(_) => {}
        }
        if self.summary.recent_matches.len() < RECENT_COUNT {
            self.summary.recent_matches.push(json!({
                "win": won,
                "champion": p.champion_name,
                "kills": p.kills,
                "deaths": p.deaths,
                "assists": p.assists,
                "timestamp": m.game_end_timestamp,
            }));
        }
    }

    /// 連勝が切れていて、直近 5 件も揃ったら true（これ以上試合を取らなくてよい）
    pub fn is_done(&self) -> bool {
        self.broken && self.summary.recent_matches.len() >= RECENT_COUNT
    }

    pub fn finish(self) -> StreakSummary {
        self.summary
    }
}

/// 新しい順の試合から連勝・連敗を数える（取得に失敗した試合は、呼ぶ側が除いて渡す）。
pub fn summarize(puuid: &str, matches: &[Match]) -> StreakSummary {
    let mut acc = StreakAccumulator::new(puuid);
    for m in matches {
        acc.push(m);
        if acc.is_done() {
            break;
        }
    }
    acc.finish()
}

/// 連勝・連敗の絶対値が大きい順に並べる。同じ値は元の順（設定に書いた順）のまま。
/// `sort_by` は安定ソートなので、PHP 8 の `usort` と同じ結果になる。
pub fn sort_results(results: &mut [Value]) {
    fn abs_streak(v: &Value) -> i64 {
        v.get("streak").and_then(Value::as_i64).unwrap_or(0).abs()
    }
    results.sort_by_key(|v| std::cmp::Reverse(abs_streak(v)));
}

/// ランクの一覧から、ソロとフレックスだけを拾う（`(soloRank, flexRank)`。無ければ Null）。
pub fn parse_ranks(entries: &Value) -> (Value, Value) {
    let Some(list) = entries.as_array() else {
        return (Value::Null, Value::Null);
    };
    let mut solo = Value::Null;
    let mut flex = Value::Null;
    for e in list {
        let rank = json!({
            "tier": e.get("tier").cloned().unwrap_or(Value::Null),
            "rank": e.get("rank").cloned().unwrap_or(Value::Null),
            "lp": e.get("leaguePoints").cloned().unwrap_or(Value::Null),
            "wins": e.get("wins").cloned().unwrap_or(Value::Null),
            "losses": e.get("losses").cloned().unwrap_or(Value::Null),
        });
        match e.get("queueType").and_then(Value::as_str) {
            Some("RANKED_SOLO_5x5") => solo = rank,
            Some("RANKED_FLEX_SR") => flex = rank,
            _ => {}
        }
    }
    (solo, flex)
}

/// Riot API の試合の JSON から [`Match`] を作る（形が違えば None）。
pub fn parse_match(v: &Value) -> Option<Match> {
    let info = v.get("info")?;
    let participants = info
        .get("participants")?
        .as_array()?
        .iter()
        .filter_map(|p| {
            Some(Participant {
                puuid: p.get("puuid")?.as_str()?.to_owned(),
                win: p.get("win").and_then(Value::as_bool).unwrap_or(false),
                champion_name: p
                    .get("championName")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                kills: p.get("kills").and_then(Value::as_i64).unwrap_or(0),
                deaths: p.get("deaths").and_then(Value::as_i64).unwrap_or(0),
                assists: p.get("assists").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect();
    Some(Match {
        participants,
        game_end_timestamp: info.get("gameEndTimestamp").and_then(Value::as_i64),
    })
}

/// 1 人分の結果（アカウントが見つからないとき）。`soloRank`・`flexRank` のキーは付けない（PHP と同じ）。
fn not_found_entry(member: &LolMember) -> Value {
    json!({
        "name": member.name,
        "tag": member.tag,
        "error": "プレイヤーが見つかりません",
        "streak": 0,
        "lastChampion": null,
        "lastMatchTime": null,
        "recentMatches": [],
    })
}

struct Cached {
    fetched_at: i64,
    value: Value,
}

pub struct LolStreakService {
    http: reqwest::Client,
    api_key: String,
    members: Vec<LolMember>,
    account_base: String,
    platform_base: String,
    /// 取得中もロックを持つ（同時に来たリクエストを 1 つずつ通し、Riot API を重ねて呼ばないため）
    cache: Mutex<Option<Cached>>,
}

impl LolStreakService {
    pub fn new(http: reqwest::Client, config: &Config) -> Self {
        Self {
            http,
            api_key: config.riot_api_key.clone(),
            members: config.lol_members.clone(),
            account_base: config.riot_account_base.clone(),
            platform_base: config.riot_platform_base.clone(),
            cache: Mutex::new(None),
        }
    }

    /// 今の streak.php と同じ配列。5 分以内ならキャッシュを返す。
    /// Riot API の失敗は PHP と同じく「見つからない・試合なし」として扱う（500 にはしない）ので、
    /// 今のところエラーは返さない。
    pub async fn get(&self, now: i64) -> AppResult<Value> {
        let mut guard = self.cache.lock().await;
        if let Some(c) = guard.as_ref()
            && now - c.fetched_at < CACHE_TTL_SECS
        {
            return Ok(c.value.clone());
        }
        let value = self.fetch_all().await;
        *guard = Some(Cached {
            fetched_at: now,
            value: value.clone(),
        });
        Ok(value)
    }

    async fn fetch_all(&self) -> Value {
        let mut results = Vec::with_capacity(self.members.len());
        for member in &self.members {
            results.push(self.fetch_member(member).await);
        }
        sort_results(&mut results);
        Value::Array(results)
    }

    async fn fetch_member(&self, member: &LolMember) -> Value {
        let account = match build_url(
            &self.account_base,
            &[
                "riot",
                "account",
                "v1",
                "accounts",
                "by-riot-id",
                &member.name,
                &member.tag,
            ],
            &[],
        ) {
            Some(url) => self.riot_get(url).await,
            None => None,
        };
        let Some(account) = account else {
            return not_found_entry(member);
        };
        let (Some(puuid), Some(name), Some(tag)) = (
            account.get("puuid").and_then(Value::as_str),
            account.get("gameName").and_then(Value::as_str),
            account.get("tagLine").and_then(Value::as_str),
        ) else {
            return not_found_entry(member);
        };

        let streak = self.fetch_streak(puuid).await;
        let (solo, flex) = self.fetch_rank(puuid).await;
        json!({
            "name": name,
            "tag": tag,
            "streak": streak.streak,
            "lastChampion": streak.last_champion,
            "lastMatchTime": streak.last_match_time,
            "recentMatches": streak.recent_matches,
            "soloRank": solo,
            "flexRank": flex,
        })
    }

    async fn fetch_streak(&self, puuid: &str) -> StreakSummary {
        let ids_url = build_url(
            &self.account_base,
            &["lol", "match", "v5", "matches", "by-puuid", puuid, "ids"],
            &[("type", "ranked"), ("count", MATCH_ID_COUNT)],
        );
        let ids = match ids_url {
            Some(url) => self.riot_get(url).await,
            None => None,
        };
        let Some(ids) = ids.as_ref().and_then(Value::as_array) else {
            return StreakSummary::empty();
        };

        let mut acc = StreakAccumulator::new(puuid);
        for id in ids.iter().filter_map(Value::as_str) {
            let Some(url) = build_url(
                &self.account_base,
                &["lol", "match", "v5", "matches", id],
                &[],
            ) else {
                continue;
            };
            // 取得に失敗した試合は飛ばして続ける
            let Some(m) = self.riot_get(url).await.as_ref().and_then(parse_match) else {
                continue;
            };
            acc.push(&m);
            if acc.is_done() {
                break;
            }
        }
        acc.finish()
    }

    async fn fetch_rank(&self, puuid: &str) -> (Value, Value) {
        let url = build_url(
            &self.platform_base,
            &["lol", "league", "v4", "entries", "by-puuid", puuid],
            &[],
        );
        match url {
            Some(url) => match self.riot_get(url).await {
                Some(entries) => parse_ranks(&entries),
                None => (Value::Null, Value::Null),
            },
            None => (Value::Null, Value::Null),
        }
    }

    /// GET して JSON を返す。200 以外・通信失敗・JSON でない・空（PHP の `?: null` と同じ）は None。
    async fn riot_get(&self, url: reqwest::Url) -> Option<Value> {
        let res = self
            .http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| tracing::warn!("Riot API に接続できませんでした: {}", e.without_url()))
            .ok()?;
        if res.status() != reqwest::StatusCode::OK {
            tracing::warn!("Riot API が {} を返しました", res.status().as_u16());
            return None;
        }
        let v: Value = res.json().await.ok()?;
        let empty = match &v {
            Value::Null | Value::Bool(false) => true,
            Value::Array(a) => a.is_empty(),
            Value::Object(o) => o.is_empty(),
            Value::String(s) => s.is_empty() || s == "0",
            Value::Number(n) => n.as_f64() == Some(0.0),
            Value::Bool(true) => false,
        };
        if empty { None } else { Some(v) }
    }
}

/// ベース URL に、パーセントエンコードしたパスの部品とクエリをつなぐ（`rawurlencode` の代わり）。
/// ベースが空など、URL にできないときは None。
fn build_url(base: &str, segments: &[&str], query: &[(&str, &str)]) -> Option<reqwest::Url> {
    let mut url = reqwest::Url::parse(base).ok()?;
    url.path_segments_mut()
        .ok()?
        .pop_if_empty()
        .extend(segments);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "me";

    fn game(win: bool, champ: &str) -> Match {
        Match {
            participants: vec![
                Participant {
                    puuid: "other".into(),
                    win: !win,
                    champion_name: "Other".into(),
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                },
                Participant {
                    puuid: ME.into(),
                    win,
                    champion_name: champ.into(),
                    kills: 1,
                    deaths: 2,
                    assists: 3,
                },
            ],
            game_end_timestamp: Some(1000),
        }
    }

    fn games(results: &[bool]) -> Vec<Match> {
        results.iter().map(|w| game(*w, "Ahri")).collect()
    }

    #[test]
    fn three_wins_then_loss() {
        let s = summarize(ME, &games(&[true, true, true, false]));
        assert_eq!(s.streak, 3);
    }

    #[test]
    fn two_losses_then_win() {
        let s = summarize(ME, &games(&[false, false, true]));
        assert_eq!(s.streak, -2);
    }

    #[test]
    fn no_matches() {
        let s = summarize(ME, &[]);
        assert_eq!(s, StreakSummary::empty());
        assert_eq!(s.last_champion, None);
        assert!(s.recent_matches.is_empty());
    }

    #[test]
    fn match_without_player_is_skipped() {
        let mut other_only = game(false, "Zed");
        other_only.participants.remove(1);
        let s = summarize(ME, &[other_only, game(true, "Ahri"), game(true, "Lux")]);
        assert_eq!(s.streak, 2);
        assert_eq!(s.last_champion.as_deref(), Some("Ahri"));
        assert_eq!(s.recent_matches.len(), 2);
    }

    #[test]
    fn collects_five_recent_even_after_streak_breaks() {
        // 勝ち 1 回で連勝が切れても、直近 5 件が揃うまで集め続ける（6 件目以降は見ない）
        let s = summarize(ME, &games(&[true, false, true, true, true, true, true]));
        assert_eq!(s.streak, 1);
        assert_eq!(s.recent_matches.len(), 5);
    }

    #[test]
    fn accumulator_stops_only_when_broken_and_five() {
        let mut acc = StreakAccumulator::new(ME);
        for w in [true, true, true, true, true] {
            acc.push(&game(w, "Ahri"));
        }
        // 5 件揃ったが連勝が切れていないので、続けて取る
        assert!(!acc.is_done());
        acc.push(&game(false, "Ahri"));
        assert!(acc.is_done());
        assert_eq!(acc.finish().streak, 5);
    }

    #[test]
    fn recent_match_fields() {
        let s = summarize(ME, &[game(true, "Ahri")]);
        assert_eq!(s.last_match_time, Some(1000));
        assert_eq!(
            s.recent_matches[0],
            json!({"win": true, "champion": "Ahri", "kills": 1, "deaths": 2, "assists": 3, "timestamp": 1000})
        );
    }

    #[test]
    fn sort_by_abs_streak_stable() {
        let mut v = vec![
            json!({"name": "a", "streak": 1}),
            json!({"name": "b", "streak": -3}),
            json!({"name": "c", "streak": 0}),
            json!({"name": "d", "streak": 3}),
            json!({"name": "e", "streak": -1}),
        ];
        sort_results(&mut v);
        let names: Vec<&str> = v.iter().map(|x| x["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["b", "d", "a", "e", "c"]);
    }

    #[test]
    fn ranks_pick_only_solo_and_flex() {
        let entries = json!([
            {"queueType": "RANKED_TFT", "tier": "GOLD", "rank": "I", "leaguePoints": 1, "wins": 1, "losses": 1},
            {"queueType": "RANKED_SOLO_5x5", "tier": "GOLD", "rank": "II", "leaguePoints": 50, "wins": 10, "losses": 8},
            {"queueType": "RANKED_FLEX_SR", "tier": "SILVER", "rank": "IV", "leaguePoints": 5, "wins": 3, "losses": 4},
        ]);
        let (solo, flex) = parse_ranks(&entries);
        assert_eq!(
            solo,
            json!({"tier": "GOLD", "rank": "II", "lp": 50, "wins": 10, "losses": 8})
        );
        assert_eq!(flex["tier"], "SILVER");
        assert_eq!(parse_ranks(&json!([])), (Value::Null, Value::Null));
        assert_eq!(parse_ranks(&Value::Null), (Value::Null, Value::Null));
    }

    #[test]
    fn url_is_percent_encoded() {
        let u = build_url(
            "http://x.test/",
            &["riot", "account", "テスト", "a/b"],
            &[("count", "20")],
        )
        .unwrap();
        assert_eq!(
            u.as_str(),
            "http://x.test/riot/account/%E3%83%86%E3%82%B9%E3%83%88/a%2Fb?count=20"
        );
        assert!(build_url("", &["a"], &[]).is_none());
    }
}
