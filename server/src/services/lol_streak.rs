//! LoL 戦績（Riot API の呼び出しと連勝の計算）。
//!
//! 【仮】T10 が中身を作る。形（型と関数のシグネチャ）は設計書 10 §6.7 のとおり。
//! 外部 API のベース URL は `config.riot_account_base` / `config.riot_platform_base`。

use crate::config::{Config, LolMember};
use crate::error::{AppError, AppResult};

#[allow(dead_code)] // T10 が中身を作るまでの間だけ（フィールドがまだ読まれていないため）
pub struct LolStreakService {
    http: reqwest::Client,
    api_key: String,
    members: Vec<LolMember>,
    account_base: String,
    platform_base: String,
}

impl LolStreakService {
    pub fn new(http: reqwest::Client, config: &Config) -> Self {
        Self {
            http,
            api_key: config.riot_api_key.clone(),
            members: config.lol_members.clone(),
            account_base: config.riot_account_base.clone(),
            platform_base: config.riot_platform_base.clone(),
        }
    }

    /// 今の streak.php と同じ配列。【仮】
    pub async fn get(&self, _now: i64) -> AppResult<serde_json::Value> {
        Err(AppError::Internal(anyhow::anyhow!("未実装です")))
    }
}
