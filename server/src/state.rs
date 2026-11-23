//! ハンドラとミドルウェアが共有するもの（設計書 10 §6.7）。
//!
//! 組み立ては `AppState::new` の 1 か所でする。本番は `AppState::for_production`、
//! テストは `tests/common::test_state()` から呼ぶ。

use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;

use crate::auth::discord::DiscordOAuth;
use crate::clock::{Clock, SystemClock};
use crate::config::Config;
use crate::middleware::rate_limit::RateLimiter;
use crate::services::game_servers::{GameServerBackend, GameServerService, UnconfiguredBackend};
use crate::services::lol_streak::LolStreakService;
use crate::services::running_relay::RunningRelay;

/// 合言葉の失敗の上限（IP ごとに 10 分で 10 回。D4）
pub const SITE_LOGIN_MAX_FAILURES: u32 = 10;
pub const SITE_LOGIN_WINDOW_SECS: i64 = 600;

/// 外部 API を呼ぶときのタイムアウト（ランニングの中継は設定で別に決める）
pub const HTTP_TIMEOUT_SECS: u64 = 10;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: SqlitePool,
    /// タイムアウト 10 秒、User-Agent "serversystem"
    pub http: reqwest::Client,
    pub clock: Arc<dyn Clock>,
    pub site_login_limiter: Arc<RateLimiter>,
    pub game_servers: Arc<GameServerService>,
    pub lol: Arc<LolStreakService>,
    pub running: Arc<RunningRelay>,
    pub discord: Arc<DiscordOAuth>,
}

impl AppState {
    /// 部品を受け取って組み立てる。ゲームサーバーの EC2 は差し替えられるよう引数で受け取る。
    pub fn new(
        config: Config,
        db: SqlitePool,
        clock: Arc<dyn Clock>,
        game_backend: Arc<dyn GameServerBackend>,
    ) -> anyhow::Result<AppState> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .user_agent("serversystem")
            .build()
            .context("HTTP クライアントを作れませんでした")?;
        Ok(AppState {
            site_login_limiter: Arc::new(RateLimiter::new(
                SITE_LOGIN_MAX_FAILURES,
                SITE_LOGIN_WINDOW_SECS,
            )),
            game_servers: Arc::new(GameServerService::new(game_backend, &config)),
            lol: Arc::new(LolStreakService::new(http.clone(), &config)),
            running: Arc::new(RunningRelay::new(http.clone(), &config)),
            discord: Arc::new(DiscordOAuth::new(http.clone(), &config)),
            config: Arc::new(config),
            db,
            http,
            clock,
        })
    }

    /// 本番用（`serve` から呼ぶ）。OS の時計と、本物の EC2 を使う。
    pub async fn for_production(config: Config, db: SqlitePool) -> anyhow::Result<AppState> {
        // T14: 次の 1 行を `Arc::new(Ec2Backend::new(&config).await?)` などに替える
        let game_backend: Arc<dyn GameServerBackend> = Arc::new(UnconfiguredBackend);
        Self::new(config, db, Arc::new(SystemClock), game_backend)
    }
}
