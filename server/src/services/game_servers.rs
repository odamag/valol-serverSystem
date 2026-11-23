//! ゲームサーバー（EC2）の状態・起動・停止。設計書 10 D2・§6.6。
//!
//! EC2 は aws-sdk をモックしにくいので `GameServerBackend` の後ろに隠し、
//! テストでは偽物を差し込む。本物は `Ec2Backend`（`AppState::for_production` で差し込む）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use aws_sdk_ec2::error::DisplayErrorContext;
use aws_sdk_ec2::types::{
    Filter, InstanceInterruptionBehavior, InstanceMarketOptionsRequest,
    LaunchTemplateSpecification, MarketType, ResourceType, SpotInstanceType, SpotMarketOptions,
    Tag, TagSpecification,
};
use serde_json::{Value, json};

use crate::config::Config;
use crate::error::{AppError, AppResult};

/// 起動中ロックの長さ（秒）。今の PHP と同じ。
pub const START_LOCK_SECS: i64 = 120;
/// 状態の取得結果をキャッシュする長さ（秒）。複数の人が 5 秒ごとに見ても AWS への問い合わせを増やさないため。
pub const STATUS_CACHE_SECS: i64 = 3;

/// 状態取得に失敗したときに画面に出す文言（AWS のエラー文は出さない。§6.3）
const STATUS_ERROR_MESSAGE: &str = "状態取得エラー";

/// 扱うゲームサーバーの定数（秘密ではない値。あとでゲームを足すときは 1 行足す）。
struct ServerDef {
    /// URL の `{target}` と、応答の `servers` のキー
    key: &'static str,
    name: &'static str,
    /// EC2 の `Name` タグ
    tag: &'static str,
    port: u16,
}

const SERVERS: &[ServerDef] = &[ServerDef {
    key: "minecraft",
    name: "⛏️ Minecraft",
    tag: "minecraft",
    port: 25565,
}];

#[async_trait]
pub trait GameServerBackend: Send + Sync {
    /// `Name` タグで探す。終了済みは除く。
    async fn find_instance(&self, name_tag: &str) -> anyhow::Result<Option<InstanceInfo>>;
    /// 起動テンプレート（`$Latest`）から起動する。
    async fn run_from_template(
        &self,
        launch_template_id: &str,
        name_tag: &str,
    ) -> anyhow::Result<()>;
    /// 終了する。
    async fn terminate(&self, instance_id: &str) -> anyhow::Result<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceInfo {
    pub instance_id: String,
    pub state: String,
    pub public_ip: Option<String>,
    pub game_status: Option<String>,
}

/// 本物の EC2。認証情報は環境変数（`AWS_ACCESS_KEY_ID` など）から aws-config が読む。
pub struct Ec2Backend {
    client: aws_sdk_ec2::Client,
}

impl Ec2Backend {
    pub async fn new(config: &Config) -> anyhow::Result<Self> {
        let sdk = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(config.aws_region.clone()))
            .load()
            .await;
        Ok(Self {
            client: aws_sdk_ec2::Client::new(&sdk),
        })
    }
}

fn describe_error(e: impl std::error::Error) -> anyhow::Error {
    anyhow::anyhow!("{}", DisplayErrorContext(e))
}

#[async_trait]
impl GameServerBackend for Ec2Backend {
    async fn find_instance(&self, name_tag: &str) -> anyhow::Result<Option<InstanceInfo>> {
        // 終了済み（terminated）と stopped は除く。status.php と同じ 4 つの状態
        let res = self
            .client
            .describe_instances()
            .filters(Filter::builder().name("tag:Name").values(name_tag).build())
            .filters(
                Filter::builder()
                    .name("instance-state-name")
                    .set_values(Some(
                        ["pending", "running", "stopping", "shutting-down"]
                            .map(String::from)
                            .to_vec(),
                    ))
                    .build(),
            )
            .send()
            .await
            .map_err(describe_error)?;

        let Some(inst) = res.reservations().iter().flat_map(|r| r.instances()).next() else {
            return Ok(None);
        };
        let game_status = inst
            .tags()
            .iter()
            .find(|t| t.key() == Some("GameStatus"))
            .and_then(|t| t.value())
            .map(str::to_owned);
        Ok(Some(InstanceInfo {
            instance_id: inst.instance_id().unwrap_or_default().to_owned(),
            state: inst
                .state()
                .and_then(|s| s.name())
                .map(|n| n.as_str().to_owned())
                .unwrap_or_default(),
            public_ip: inst.public_ip_address().map(str::to_owned),
            game_status,
        }))
    }

    async fn run_from_template(
        &self,
        launch_template_id: &str,
        name_tag: &str,
    ) -> anyhow::Result<()> {
        self.client
            .run_instances()
            .launch_template(
                LaunchTemplateSpecification::builder()
                    .launch_template_id(launch_template_id)
                    .version("$Latest")
                    .build(),
            )
            .min_count(1)
            .max_count(1)
            .instance_market_options(
                InstanceMarketOptionsRequest::builder()
                    .market_type(MarketType::Spot)
                    .spot_options(
                        SpotMarketOptions::builder()
                            .spot_instance_type(SpotInstanceType::OneTime)
                            .instance_interruption_behavior(InstanceInterruptionBehavior::Terminate)
                            .build(),
                    )
                    .build(),
            )
            .tag_specifications(
                TagSpecification::builder()
                    .resource_type(ResourceType::Instance)
                    .tags(Tag::builder().key("Name").value(name_tag).build())
                    .tags(Tag::builder().key("GameStatus").value("Booting").build())
                    .build(),
            )
            .send()
            .await
            .map_err(describe_error)?;
        Ok(())
    }

    async fn terminate(&self, instance_id: &str) -> anyhow::Result<()> {
        self.client
            .terminate_instances()
            .instance_ids(instance_id)
            .send()
            .await
            .map_err(describe_error)?;
        Ok(())
    }
}

/// 【仮】バックエンドを用意していない状態（テストの既定）。どの呼び出しもエラーにする。
pub struct UnconfiguredBackend;

#[async_trait]
impl GameServerBackend for UnconfiguredBackend {
    async fn find_instance(&self, _name_tag: &str) -> anyhow::Result<Option<InstanceInfo>> {
        anyhow::bail!("ゲームサーバーのバックエンドが未設定です")
    }
    async fn run_from_template(
        &self,
        _launch_template_id: &str,
        _name_tag: &str,
    ) -> anyhow::Result<()> {
        anyhow::bail!("ゲームサーバーのバックエンドが未設定です")
    }
    async fn terminate(&self, _instance_id: &str) -> anyhow::Result<()> {
        anyhow::bail!("ゲームサーバーのバックエンドが未設定です")
    }
}

pub struct GameServerService {
    backend: Arc<dyn GameServerBackend>,
    launch_template_minecraft: String,
    /// 起動中ロック：ターゲット → 起動を始めた時刻。再起動で消えてよい（起動時に必ず EC2 で重複を確かめる）。
    start_locks: Mutex<HashMap<&'static str, i64>>,
    /// ターゲットごとの「起動・停止を 1 つずつしか通さない」Mutex（同時に 2 回押しても 2 台立たないため）
    op_guards: HashMap<&'static str, tokio::sync::Mutex<()>>,
    /// 状態のキャッシュ：(取得した時刻, 応答)
    cache: Mutex<Option<(i64, Value)>>,
}

fn find_def(target: &str) -> Option<&'static ServerDef> {
    SERVERS.iter().find(|d| d.key == target)
}

impl GameServerService {
    pub fn new(backend: Arc<dyn GameServerBackend>, config: &Config) -> Self {
        Self {
            backend,
            launch_template_minecraft: config.ec2_lt_minecraft.clone(),
            start_locks: Mutex::new(HashMap::new()),
            op_guards: SERVERS
                .iter()
                .map(|d| (d.key, tokio::sync::Mutex::new(())))
                .collect(),
            cache: Mutex::new(None),
        }
    }

    /// 起動テンプレート ID の設定名への対応（ゲームを足すときはここも 1 行足す）
    fn launch_template(&self, def: &ServerDef) -> &str {
        match def.key {
            "minecraft" => &self.launch_template_minecraft,
            _ => "",
        }
    }

    /// ターゲットが一覧にあるか（ルートで 404 にするため）
    pub fn is_known_target(target: &str) -> bool {
        find_def(target).is_some()
    }

    fn drop_cache(&self) {
        *self.cache.lock().expect("cache") = None;
    }

    fn lock_active(&self, key: &str, now: i64) -> bool {
        let locks = self.start_locks.lock().expect("locks");
        locks
            .get(key)
            .is_some_and(|&t| (0..START_LOCK_SECS).contains(&(now - t)))
    }

    /// status.php と同じ形の JSON（`{"servers": {...}, "message": ""}`）。
    pub async fn status(&self, now: i64) -> AppResult<Value> {
        if let Some((at, v)) = &*self.cache.lock().expect("cache")
            && (0..STATUS_CACHE_SECS).contains(&(now - at))
        {
            return Ok(v.clone());
        }

        let mut servers = serde_json::Map::new();
        let mut failed = false;
        for def in SERVERS {
            let found = match self.backend.find_instance(def.tag).await {
                Ok(f) => f,
                Err(e) => {
                    // AWS のエラー文は画面に出さずログにだけ残す（§6.3）
                    tracing::error!(error = format!("{e:#}"), target = def.key, "状態取得に失敗");
                    failed = true;
                    None
                }
            };
            let lock_active = self.lock_active(def.key, now);
            servers.insert(def.key.to_owned(), entry_json(def, found, lock_active));
        }
        let message = if failed { STATUS_ERROR_MESSAGE } else { "" };
        let value = json!({ "servers": servers, "message": message });
        // 失敗した結果は覚えない（直ったらすぐ反映するため）
        if !failed {
            *self.cache.lock().expect("cache") = Some((now, value.clone()));
        }
        Ok(value)
    }

    /// 起動する。成功時の message を返す。
    pub async fn start(&self, target: &str, now: i64) -> AppResult<String> {
        let def = find_def(target).ok_or(AppError::NotFound)?;
        // 「ロックを確かめる → EC2 を確かめる → 起動する」を 1 つずつ通す
        let _guard = self.op_guards[def.key].lock().await;

        if self.lock_active(def.key, now) {
            return Err(AppError::Conflict(format!(
                "⚠️ {} は起動処理中です。",
                def.name
            )));
        }
        self.start_locks.lock().expect("locks").insert(def.key, now);
        self.drop_cache();

        let result = self.start_inner(def).await;
        if result.is_err() {
            // 失敗したら、すぐやり直せるようロックを外す
            self.start_locks.lock().expect("locks").remove(def.key);
        }
        self.drop_cache();
        result
    }

    async fn start_inner(&self, def: &ServerDef) -> AppResult<String> {
        let existing = self
            .backend
            .find_instance(def.tag)
            .await
            .map_err(AppError::Upstream)?;
        if existing.is_some() {
            return Err(AppError::Conflict(
                "⚠️ すでに起動しているか、終了処理中です。".to_owned(),
            ));
        }
        self.backend
            .run_from_template(self.launch_template(def), def.tag)
            .await
            .map_err(AppError::Upstream)?;
        Ok("🚀 起動リクエストを送信しました".to_owned())
    }

    /// 停止する。成功時の message を返す。
    ///
    /// 停止する相手はクライアントの指定ではなく、サーバー側でタグから探す（D2）。
    pub async fn stop(&self, target: &str) -> AppResult<String> {
        let def = find_def(target).ok_or(AppError::NotFound)?;
        let _guard = self.op_guards[def.key].lock().await;

        let found = self
            .backend
            .find_instance(def.tag)
            .await
            .map_err(AppError::Upstream)?;
        let Some(inst) = found else {
            return Err(AppError::Conflict(
                "⚠️ 停止するサーバーが見つかりません".to_owned(),
            ));
        };
        self.backend
            .terminate(&inst.instance_id)
            .await
            .map_err(AppError::Upstream)?;
        self.start_locks.lock().expect("locks").remove(def.key);
        self.drop_cache();
        Ok("停止リクエストを送信しました".to_owned())
    }
}

/// 1 台分の応答。`displayState` の決め方は設計書 10 §6.6 の表のとおり。
fn entry_json(def: &ServerDef, found: Option<InstanceInfo>, lock_active: bool) -> Value {
    let (state, display, ip, id, gs) = match found {
        Some(i) => {
            let gs = i.game_status.unwrap_or_default();
            let display = match i.state.as_str() {
                "shutting-down" | "stopping" => "closing",
                "running" if gs == "Online" => "ready",
                "running" => "loading",
                "pending" => "pending",
                _ => "stopped",
            };
            (
                i.state,
                display,
                i.public_ip.unwrap_or_default(),
                i.instance_id,
                gs,
            )
        }
        None => {
            let display = if lock_active { "pending" } else { "stopped" };
            (
                "stopped".to_owned(),
                display,
                String::new(),
                String::new(),
                String::new(),
            )
        }
    };
    json!({
        "name": def.name,
        "port": def.port,
        "state": state,
        "displayState": display,
        "ip": ip,
        "instanceId": id,
        "gameStatus": gs,
    })
}
