//! Discord OAuth（トークン交換・@me・ギルドのメンバー確認）。設計書 10 D3・§4。
//!
//! 外部 API のベース URL は `config.discord_api_base`（本番は `https://discord.com/api/v10`、
//! テストでは wiremock に向ける）。認可画面はブラウザが開くページなので、ベースから
//! `/api` 以降を外したオリジンに `/oauth2/authorize` を付けて作る（本番は
//! `https://discord.com/oauth2/authorize`。Discord の文書の URL）。
//!
//! ここはエラーを `anyhow` で返すだけにして、どの `discord_error` に変えるかは
//! 呼ぶ側（`routes::auth::discord_callback`）が決める。

use anyhow::{Context, bail};
use reqwest::StatusCode;
use serde::Deserialize;

use crate::config::Config;

/// 求める権限。`guilds.members.read` でギルドのメンバーかどうかだけを確かめる（D3）
pub const DISCORD_SCOPE: &str = "identify guilds.members.read";

pub struct DiscordOAuth {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
    guild_id: String,
    api_base: String,
    http: reqwest::Client,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DiscordMe {
    pub id: String,
    pub username: String,
    #[serde(default)]
    pub global_name: Option<String>,
}

impl DiscordMe {
    /// 画面に出す名前。`global_name`（新しい表示名）が空でなければそれ、無ければ `username`。
    /// どちらも空のときは今の PHP と同じく "Discord User" にする。
    pub fn display_name(&self) -> String {
        let pick = |s: &str| {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_owned())
        };
        self.global_name
            .as_deref()
            .and_then(pick)
            .or_else(|| pick(&self.username))
            .unwrap_or_else(|| "Discord User".to_owned())
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
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

    /// 認可画面の URL（scope=identify guilds.members.read, prompt=none）。
    /// 値はすべて URL エンコードする（state などを文字列に直接つながないため）。
    pub fn authorize_url(&self, state: &str) -> String {
        let origin = match self.api_base.find("/api") {
            Some(i) => &self.api_base[..i],
            None => self.api_base.as_str(),
        };
        let base = format!("{origin}/oauth2/authorize");
        // ベース URL は設定の読み込み時に確かめていないので、壊れていたら本物の URL に倒す
        let mut url = reqwest::Url::parse(&base).unwrap_or_else(|_| {
            reqwest::Url::parse("https://discord.com/oauth2/authorize").expect("固定の URL")
        });
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", DISCORD_SCOPE)
            .append_pair("state", state)
            // 同意済みなら画面を出さずに戻す（scope が変わった最初の 1 回だけは同意画面が出る）
            .append_pair("prompt", "none");
        url.into()
    }

    /// code をアクセストークンに換える（POST /oauth2/token）。
    pub async fn exchange_code(&self, code: &str) -> anyhow::Result<String> {
        let res = self
            .http
            .post(format!("{}/oauth2/token", self.api_base))
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", self.redirect_uri.as_str()),
            ])
            .send()
            .await
            .context("トークンの交換を送れませんでした")?;
        let status = res.status();
        if !status.is_success() {
            // 応答の本文には秘密が入りうるので、ログ用のエラーにはステータスだけを入れる
            bail!("トークンの交換が失敗しました: {status}");
        }
        let body: TokenResponse = res
            .json()
            .await
            .context("トークンの応答を読めませんでした")?;
        if body.access_token.is_empty() {
            bail!("アクセストークンが空でした");
        }
        Ok(body.access_token)
    }

    /// GET /users/@me。
    pub async fn fetch_me(&self, access_token: &str) -> anyhow::Result<DiscordMe> {
        let res = self
            .http
            .get(format!("{}/users/@me", self.api_base))
            .bearer_auth(access_token)
            .send()
            .await
            .context("ユーザー情報を取りに行けませんでした")?;
        let status = res.status();
        if !status.is_success() {
            bail!("ユーザー情報の取得が失敗しました: {status}");
        }
        let me: DiscordMe = res.json().await.context("ユーザー情報を読めませんでした")?;
        // Discord の ID は数字だけ（snowflake）。それ以外は DB に入れない
        if me.id.is_empty() || !me.id.bytes().all(|b| b.is_ascii_digit()) {
            bail!("Discord の ID の形がおかしいです");
        }
        Ok(me)
    }

    /// GET /users/@me/guilds/{GUILD}/member。200 なら true、404 なら false、それ以外はエラー。
    pub async fn is_guild_member(&self, access_token: &str) -> anyhow::Result<bool> {
        let res = self
            .http
            .get(format!(
                "{}/users/@me/guilds/{}/member",
                self.api_base, self.guild_id
            ))
            .bearer_auth(access_token)
            .send()
            .await
            .context("ギルドのメンバー情報を取りに行けませんでした")?;
        match res.status() {
            s if s.is_success() => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            s => bail!("ギルドのメンバー情報の取得が失敗しました: {s}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn me(username: &str, global: Option<&str>) -> DiscordMe {
        DiscordMe {
            id: "1".into(),
            username: username.into(),
            global_name: global.map(str::to_owned),
        }
    }

    #[test]
    fn display_name_prefers_global_name() {
        assert_eq!(me("user", Some("表示名")).display_name(), "表示名");
        assert_eq!(me("user", None).display_name(), "user");
        assert_eq!(me("user", Some("  ")).display_name(), "user");
        assert_eq!(me("", None).display_name(), "Discord User");
    }

    #[test]
    fn authorize_url_has_encoded_params() {
        let mut config = Config::for_test();
        config.discord_api_base = "https://discord.example/api/v10".into();
        let d = DiscordOAuth::new(reqwest::Client::new(), &config);
        let url = reqwest::Url::parse(&d.authorize_url("a&b=c")).unwrap();
        assert_eq!(url.host_str(), Some("discord.example"));
        assert_eq!(url.path(), "/oauth2/authorize");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "test-client-id");
        assert_eq!(q["redirect_uri"], config.discord_redirect_uri);
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "identify guilds.members.read");
        assert_eq!(q["state"], "a&b=c");
        assert_eq!(q["prompt"], "none");
    }
}
