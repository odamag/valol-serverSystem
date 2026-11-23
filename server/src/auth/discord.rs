//! Discord OAuth（トークン交換・@me・ギルドのメンバー確認）。設計書 10 D3・§4。
//!
//! 【仮】T13 が中身を作る。形（型と関数のシグネチャ）は設計書 10 §6.7 のとおり。
//! 外部 API のベース URL は `config.discord_api_base`（テストでは wiremock に向ける）。

use crate::config::Config;

#[allow(dead_code)] // T13 が中身を作るまでの間だけ（フィールドがまだ読まれていないため）
pub struct DiscordOAuth {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    guild_id: String,
    api_base: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug)]
pub struct DiscordMe {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
}

impl DiscordOAuth {
    pub fn new(http: reqwest::Client, config: &Config) -> Self {
        Self {
            client_id: config.discord_client_id.clone(),
            client_secret: config.discord_client_secret.clone(),
            redirect_uri: config.discord_redirect_uri.clone(),
            guild_id: config.discord_guild_id.clone(),
            api_base: config.discord_api_base.clone(),
            http,
        }
    }

    /// 認可画面の URL（scope=identify guilds.members.read, prompt=none）。【仮】
    pub fn authorize_url(&self, _state: &str) -> String {
        String::new()
    }

    /// code をアクセストークンに換える。【仮】
    pub async fn exchange_code(&self, _code: &str) -> anyhow::Result<String> {
        anyhow::bail!("未実装です")
    }

    /// GET /users/@me。【仮】
    pub async fn fetch_me(&self, _access_token: &str) -> anyhow::Result<DiscordMe> {
        anyhow::bail!("未実装です")
    }

    /// GET /users/@me/guilds/{GUILD}/member。404 なら false。【仮】
    pub async fn is_guild_member(&self, _access_token: &str) -> anyhow::Result<bool> {
        anyhow::bail!("未実装です")
    }
}
