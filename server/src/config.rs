//! 設定（設計書 10 §6.5）。
//!
//! 環境変数を手で読む。足りない項目・おかしな値は 1 つ目で止めず、全部まとめて
//! エラーにする（本番で 1 つずつ直しては再起動、を繰り返さずに済むように）。
//! `Debug` ではシークレットを伏せる（ログに出しても漏れないように）。

use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;

/// 外部 API の本物の URL（テストでは設定で wiremock に向ける）
pub const DEFAULT_DISCORD_API_BASE: &str = "https://discord.com/api/v10";
pub const DEFAULT_RIOT_ACCOUNT_BASE: &str = "https://asia.api.riotgames.com";
pub const DEFAULT_RIOT_PLATFORM_BASE: &str = "https://jp1.api.riotgames.com";

/// `Config::for_test()` の `site_password_hash` に入っている合言葉
pub const TEST_SITE_PASSWORD: &str = "test-site-password";

/// LoL 戦績を出すメンバー（`LOL_MEMBERS` の 1 件。`名前#タグ`）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LolMember {
    pub name: String,
    pub tag: String,
}

#[derive(Clone)]
pub struct Config {
    /// `APP_LISTEN`（省略時 127.0.0.1:8081）
    pub listen: SocketAddr,
    /// `APP_DATABASE_PATH`
    pub database_path: PathBuf,
    /// `APP_PUBLIC_ORIGIN`。末尾の `/` は取り除いてある（例 `https://example.com`）
    pub public_origin: String,
    /// `APP_COOKIE_SECURE`（省略時 true。開発時だけ false）
    pub cookie_secure: bool,
    /// `APP_SITE_GATE_ENABLED`（省略時 true。安全なほうに倒すため）
    pub site_gate_enabled: bool,
    /// `SITE_PASSWORD_HASH`（bcrypt。`$2y$` も可）
    pub site_password_hash: String,
    /// `DISCORD_CLIENT_ID`
    pub discord_client_id: String,
    /// `DISCORD_CLIENT_SECRET`
    pub discord_client_secret: String,
    /// `DISCORD_REDIRECT_URI`
    pub discord_redirect_uri: String,
    /// `DISCORD_GUILD_ID`
    pub discord_guild_id: String,
    /// `AWS_ACCESS_KEY_ID`（aws-config も同じ変数を自分で読む。ここでは揃っているかを確かめるために持つ）
    pub aws_access_key_id: String,
    /// `AWS_SECRET_ACCESS_KEY`
    pub aws_secret_access_key: String,
    /// `AWS_REGION`
    pub aws_region: String,
    /// `EC2_LT_MINECRAFT`（起動テンプレート ID）
    pub ec2_lt_minecraft: String,
    /// `RIOT_API_KEY`
    pub riot_api_key: String,
    /// `LOL_MEMBERS`（`名前#JP1,名前2#TAG`）
    pub lol_members: Vec<LolMember>,
    /// `RUNNING_API_BASE`（末尾の `/` は取り除いてある）
    pub running_api_base: String,
    /// `RUNNING_SHARED_SECRET`
    pub running_shared_secret: String,
    /// `RUNNING_TIMEOUT_SECS`（省略時 10）
    pub running_timeout_secs: u64,
    /// `DISCORD_API_BASE`（省略時は本物。末尾の `/` なし）
    pub discord_api_base: String,
    /// `RIOT_ACCOUNT_BASE`（地域の API。account-v1・match-v5。省略時は本物）
    pub riot_account_base: String,
    /// `RIOT_PLATFORM_BASE`（サーバーごとの API。league-v4。省略時は本物）
    pub riot_platform_base: String,
}

impl Config {
    /// 環境変数から読む。足りない項目を全部並べてエラーにする。
    pub fn from_env() -> anyhow::Result<Config> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// `from_env` の中身。テストで環境変数を書き換えずに済むよう、読み方を引数で受け取る
    /// （環境変数の書き換えはテストを並べて流すと互いに干渉するため）。
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config> {
        let mut r = Reader {
            get: &get,
            missing: Vec::new(),
            invalid: Vec::new(),
        };

        let listen = r
            .optional("APP_LISTEN")
            .unwrap_or_else(|| "127.0.0.1:8081".to_owned());
        let listen = match listen.parse::<SocketAddr>() {
            Ok(a) => Some(a),
            Err(_) => {
                r.invalid.push(format!(
                    "APP_LISTEN（`127.0.0.1:8081` の形で書く）: {listen}"
                ));
                None
            }
        };
        let database_path = r.required("APP_DATABASE_PATH");
        let public_origin = r.required("APP_PUBLIC_ORIGIN").map(trim_slash);
        if let Some(o) = &public_origin
            && !(o.starts_with("https://") || o.starts_with("http://"))
        {
            r.invalid.push(format!(
                "APP_PUBLIC_ORIGIN（https:// で始める。パスは付けない）: {o}"
            ));
        }
        let cookie_secure = r.bool_or("APP_COOKIE_SECURE", true);
        let site_gate_enabled = r.bool_or("APP_SITE_GATE_ENABLED", true);
        let site_password_hash = r.required("SITE_PASSWORD_HASH");
        let discord_client_id = r.required("DISCORD_CLIENT_ID");
        let discord_client_secret = r.required("DISCORD_CLIENT_SECRET");
        let discord_redirect_uri = r.required("DISCORD_REDIRECT_URI");
        let discord_guild_id = r.required("DISCORD_GUILD_ID");
        let aws_access_key_id = r.required("AWS_ACCESS_KEY_ID");
        let aws_secret_access_key = r.required("AWS_SECRET_ACCESS_KEY");
        let aws_region = r.required("AWS_REGION");
        let ec2_lt_minecraft = r.required("EC2_LT_MINECRAFT");
        let riot_api_key = r.required("RIOT_API_KEY");
        let lol_members = match r.required("LOL_MEMBERS") {
            Some(raw) => match parse_lol_members(&raw) {
                Ok(m) => Some(m),
                Err(e) => {
                    r.invalid.push(format!("LOL_MEMBERS（{e}）"));
                    None
                }
            },
            None => None,
        };
        let running_api_base = r.required("RUNNING_API_BASE").map(trim_slash);
        let running_shared_secret = r.required("RUNNING_SHARED_SECRET");
        let running_timeout_secs = match r.optional("RUNNING_TIMEOUT_SECS") {
            None => Some(10),
            Some(v) => match v.parse::<u64>() {
                Ok(n) if n > 0 => Some(n),
                _ => {
                    r.invalid
                        .push(format!("RUNNING_TIMEOUT_SECS（1 以上の整数）: {v}"));
                    None
                }
            },
        };
        let discord_api_base = r
            .optional("DISCORD_API_BASE")
            .map(trim_slash)
            .unwrap_or_else(|| DEFAULT_DISCORD_API_BASE.to_owned());
        let riot_account_base = r
            .optional("RIOT_ACCOUNT_BASE")
            .map(trim_slash)
            .unwrap_or_else(|| DEFAULT_RIOT_ACCOUNT_BASE.to_owned());
        let riot_platform_base = r
            .optional("RIOT_PLATFORM_BASE")
            .map(trim_slash)
            .unwrap_or_else(|| DEFAULT_RIOT_PLATFORM_BASE.to_owned());

        if !r.missing.is_empty() || !r.invalid.is_empty() {
            let mut msg = String::from("設定が足りないか、正しくありません。");
            if !r.missing.is_empty() {
                msg.push_str(&format!("\n足りない環境変数: {}", r.missing.join(", ")));
            }
            for i in &r.invalid {
                msg.push_str(&format!("\n値が正しくない: {i}"));
            }
            anyhow::bail!(msg);
        }

        // ここまで来れば、必須の項目はすべて Some になっている
        Ok(Config {
            listen: listen.expect("検査済み"),
            database_path: PathBuf::from(database_path.expect("検査済み")),
            public_origin: public_origin.expect("検査済み"),
            cookie_secure: cookie_secure.expect("検査済み"),
            site_gate_enabled: site_gate_enabled.expect("検査済み"),
            site_password_hash: site_password_hash.expect("検査済み"),
            discord_client_id: discord_client_id.expect("検査済み"),
            discord_client_secret: discord_client_secret.expect("検査済み"),
            discord_redirect_uri: discord_redirect_uri.expect("検査済み"),
            discord_guild_id: discord_guild_id.expect("検査済み"),
            aws_access_key_id: aws_access_key_id.expect("検査済み"),
            aws_secret_access_key: aws_secret_access_key.expect("検査済み"),
            aws_region: aws_region.expect("検査済み"),
            ec2_lt_minecraft: ec2_lt_minecraft.expect("検査済み"),
            riot_api_key: riot_api_key.expect("検査済み"),
            lol_members: lol_members.expect("検査済み"),
            running_api_base: running_api_base.expect("検査済み"),
            running_shared_secret: running_shared_secret.expect("検査済み"),
            running_timeout_secs: running_timeout_secs.expect("検査済み"),
            discord_api_base,
            riot_account_base,
            riot_platform_base,
        })
    }

    /// テスト用の固定値。外部 URL は空なので、使うテストは wiremock の URL を入れる。
    /// 合言葉は [`TEST_SITE_PASSWORD`]（bcrypt のコストは速さのため 4）。
    pub fn for_test() -> Config {
        Config {
            listen: "127.0.0.1:0".parse().expect("固定値"),
            database_path: PathBuf::from(":memory:"),
            public_origin: "https://example.com".to_owned(),
            cookie_secure: true,
            site_gate_enabled: true,
            site_password_hash: bcrypt::hash(TEST_SITE_PASSWORD, 4).expect("bcrypt"),
            discord_client_id: "test-client-id".to_owned(),
            discord_client_secret: "test-client-secret".to_owned(),
            discord_redirect_uri: "https://example.com/api/v1/auth/discord/callback".to_owned(),
            discord_guild_id: "000000000000000001".to_owned(),
            aws_access_key_id: "AKIATEST".to_owned(),
            aws_secret_access_key: "test-secret".to_owned(),
            aws_region: "ap-northeast-1".to_owned(),
            ec2_lt_minecraft: "lt-test".to_owned(),
            riot_api_key: "RGAPI-test".to_owned(),
            lol_members: vec![LolMember {
                name: "テスト".to_owned(),
                tag: "JP1".to_owned(),
            }],
            running_api_base: String::new(),
            running_shared_secret: "test-shared-secret".to_owned(),
            running_timeout_secs: 10,
            discord_api_base: String::new(),
            riot_account_base: String::new(),
            riot_platform_base: String::new(),
        }
    }
}

/// シークレットを伏せた Debug（ログに Config を出しても漏れないように）
impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        const HIDDEN: &str = "<伏せ字>";
        f.debug_struct("Config")
            .field("listen", &self.listen)
            .field("database_path", &self.database_path)
            .field("public_origin", &self.public_origin)
            .field("cookie_secure", &self.cookie_secure)
            .field("site_gate_enabled", &self.site_gate_enabled)
            .field("site_password_hash", &HIDDEN)
            .field("discord_client_id", &self.discord_client_id)
            .field("discord_client_secret", &HIDDEN)
            .field("discord_redirect_uri", &self.discord_redirect_uri)
            .field("discord_guild_id", &self.discord_guild_id)
            .field("aws_access_key_id", &self.aws_access_key_id)
            .field("aws_secret_access_key", &HIDDEN)
            .field("aws_region", &self.aws_region)
            .field("ec2_lt_minecraft", &self.ec2_lt_minecraft)
            .field("riot_api_key", &HIDDEN)
            .field("lol_members", &self.lol_members)
            .field("running_api_base", &self.running_api_base)
            .field("running_shared_secret", &HIDDEN)
            .field("running_timeout_secs", &self.running_timeout_secs)
            .field("discord_api_base", &self.discord_api_base)
            .field("riot_account_base", &self.riot_account_base)
            .field("riot_platform_base", &self.riot_platform_base)
            .finish()
    }
}

/// 足りない項目と、おかしな値を貯めながら読む
struct Reader<'a> {
    get: &'a dyn Fn(&str) -> Option<String>,
    missing: Vec<&'static str>,
    invalid: Vec<String>,
}

impl Reader<'_> {
    /// 空文字は「書いていない」と同じに扱う（`KEY=` だけの行を見落とさないため）
    fn optional(&self, key: &str) -> Option<String> {
        (self.get)(key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    }

    fn required(&mut self, key: &'static str) -> Option<String> {
        let v = self.optional(key);
        if v.is_none() {
            self.missing.push(key);
        }
        v
    }

    fn bool_or(&mut self, key: &'static str, default: bool) -> Option<bool> {
        match self.optional(key) {
            None => Some(default),
            Some(v) => match v.to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "on" => Some(true),
                "false" | "0" | "no" | "off" => Some(false),
                _ => {
                    self.invalid.push(format!("{key}（true か false）: {v}"));
                    None
                }
            },
        }
    }
}

fn trim_slash(s: String) -> String {
    s.trim_end_matches('/').to_owned()
}

/// `名前#JP1,名前2#TAG` を分ける。名前に `#` は入らないので、最後の `#` で分ける。
fn parse_lol_members(raw: &str) -> Result<Vec<LolMember>, String> {
    let mut out = Vec::new();
    for part in raw.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        match part.rsplit_once('#') {
            Some((name, tag)) if !name.trim().is_empty() && !tag.trim().is_empty() => {
                out.push(LolMember {
                    name: name.trim().to_owned(),
                    tag: tag.trim().to_owned(),
                })
            }
            _ => return Err(format!("`名前#タグ` の形になっていない: {part}")),
        }
    }
    if out.is_empty() {
        return Err("1 人も書かれていない".to_owned());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn full_env() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("APP_DATABASE_PATH", "/tmp/app.db"),
            ("APP_PUBLIC_ORIGIN", "https://example.com/"),
            ("SITE_PASSWORD_HASH", "$2y$10$dummy"),
            ("DISCORD_CLIENT_ID", "1"),
            ("DISCORD_CLIENT_SECRET", "s"),
            ("DISCORD_REDIRECT_URI", "https://example.com/cb"),
            ("DISCORD_GUILD_ID", "2"),
            ("AWS_ACCESS_KEY_ID", "AKIA"),
            ("AWS_SECRET_ACCESS_KEY", "x"),
            ("AWS_REGION", "ap-northeast-1"),
            ("EC2_LT_MINECRAFT", "lt-1"),
            ("RIOT_API_KEY", "RGAPI"),
            ("LOL_MEMBERS", "名前#JP1, 名前2#TAG"),
            ("RUNNING_API_BASE", "https://run.example.com/"),
            ("RUNNING_SHARED_SECRET", "y"),
        ])
    }

    fn load(env: &HashMap<&'static str, &'static str>) -> anyhow::Result<Config> {
        Config::from_lookup(|k| env.get(k).map(|v| v.to_string()))
    }

    #[test]
    fn reads_full_env_with_defaults() {
        let c = load(&full_env()).unwrap();
        assert_eq!(c.listen.to_string(), "127.0.0.1:8081");
        assert_eq!(c.public_origin, "https://example.com");
        assert_eq!(c.running_api_base, "https://run.example.com");
        assert!(c.cookie_secure);
        assert!(c.site_gate_enabled);
        assert_eq!(c.running_timeout_secs, 10);
        assert_eq!(c.discord_api_base, DEFAULT_DISCORD_API_BASE);
        assert_eq!(
            c.lol_members,
            vec![
                LolMember {
                    name: "名前".into(),
                    tag: "JP1".into()
                },
                LolMember {
                    name: "名前2".into(),
                    tag: "TAG".into()
                },
            ]
        );
    }

    #[test]
    fn lists_all_missing_variables() {
        let err = Config::from_lookup(|_| None).unwrap_err().to_string();
        for key in [
            "APP_DATABASE_PATH",
            "APP_PUBLIC_ORIGIN",
            "SITE_PASSWORD_HASH",
            "DISCORD_CLIENT_ID",
            "DISCORD_CLIENT_SECRET",
            "DISCORD_REDIRECT_URI",
            "DISCORD_GUILD_ID",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_REGION",
            "EC2_LT_MINECRAFT",
            "RIOT_API_KEY",
            "LOL_MEMBERS",
            "RUNNING_API_BASE",
            "RUNNING_SHARED_SECRET",
        ] {
            assert!(err.contains(key), "{key} がエラーに無い: {err}");
        }
        // 省略できるものは並べない
        assert!(!err.contains("APP_LISTEN"));
        assert!(!err.contains("APP_SITE_GATE_ENABLED"));
    }

    #[test]
    fn empty_value_is_missing_and_bad_values_are_listed() {
        let mut env = full_env();
        env.insert("DISCORD_GUILD_ID", "  ");
        env.insert("APP_SITE_GATE_ENABLED", "maybe");
        env.insert("RUNNING_TIMEOUT_SECS", "abc");
        env.insert("LOL_MEMBERS", "タグなし");
        let err = load(&env).unwrap_err().to_string();
        assert!(err.contains("DISCORD_GUILD_ID"));
        assert!(err.contains("APP_SITE_GATE_ENABLED"));
        assert!(err.contains("RUNNING_TIMEOUT_SECS"));
        assert!(err.contains("LOL_MEMBERS"));
    }

    #[test]
    fn gate_can_be_disabled() {
        let mut env = full_env();
        env.insert("APP_SITE_GATE_ENABLED", "false");
        env.insert("APP_COOKIE_SECURE", "false");
        let c = load(&env).unwrap();
        assert!(!c.site_gate_enabled);
        assert!(!c.cookie_secure);
    }

    #[test]
    fn debug_hides_secrets() {
        let mut env = full_env();
        env.insert("DISCORD_CLIENT_SECRET", "very-secret-value");
        env.insert("RUNNING_SHARED_SECRET", "another-secret-value");
        let c = load(&env).unwrap();
        let s = format!("{c:?}");
        assert!(!s.contains("very-secret-value"));
        assert!(!s.contains("another-secret-value"));
        assert!(!s.contains("$2y$10$dummy"));
    }
}
