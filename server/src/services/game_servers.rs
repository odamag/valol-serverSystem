//! ゲームサーバー（EC2）の状態・起動・停止。設計書 10 D2・§6.6。
//!
//! 【仮】T14 が中身を作る。形（型と関数のシグネチャ）は設計書 10 §6.7 のとおり。
//! EC2 は aws-sdk をモックしにくいので `GameServerBackend` の後ろに隠し、
//! テストでは偽物を差し込む。本物（Ec2Backend）は `state.rs` の `AppState::for_production` で差し込む。

use std::sync::Arc;

use async_trait::async_trait;

use crate::config::Config;
use crate::error::{AppError, AppResult};

// T14 が Ec2Backend で使うまでの間、「使っていない依存」の警告を出さないため
use aws_config as _;
use aws_sdk_ec2 as _;

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

/// 【仮】Ec2Backend ができるまでの代わり。どの呼び出しもエラーにする。
pub struct UnconfiguredBackend;

#[async_trait]
impl GameServerBackend for UnconfiguredBackend {
    async fn find_instance(&self, _name_tag: &str) -> anyhow::Result<Option<InstanceInfo>> {
        anyhow::bail!("ゲームサーバーのバックエンドが未実装です")
    }
    async fn run_from_template(
        &self,
        _launch_template_id: &str,
        _name_tag: &str,
    ) -> anyhow::Result<()> {
        anyhow::bail!("ゲームサーバーのバックエンドが未実装です")
    }
    async fn terminate(&self, _instance_id: &str) -> anyhow::Result<()> {
        anyhow::bail!("ゲームサーバーのバックエンドが未実装です")
    }
}

#[allow(dead_code)] // T14 が中身を作るまでの間だけ（フィールドがまだ読まれていないため）
pub struct GameServerService {
    backend: Arc<dyn GameServerBackend>,
    launch_template_minecraft: String,
}

impl GameServerService {
    pub fn new(backend: Arc<dyn GameServerBackend>, config: &Config) -> Self {
        Self {
            backend,
            launch_template_minecraft: config.ec2_lt_minecraft.clone(),
        }
    }

    /// 今の status.php と同じ形の JSON。【仮】
    pub async fn status(&self, _now: i64) -> AppResult<serde_json::Value> {
        Err(AppError::Internal(anyhow::anyhow!("未実装です")))
    }

    /// 起動する。成功時の message を返す。【仮】
    pub async fn start(&self, _target: &str, _now: i64) -> AppResult<String> {
        Err(AppError::Internal(anyhow::anyhow!("未実装です")))
    }

    /// 停止する。成功時の message を返す。【仮】
    pub async fn stop(&self, _target: &str) -> AppResult<String> {
        Err(AppError::Internal(anyhow::anyhow!("未実装です")))
    }
}
