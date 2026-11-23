//! サブコマンドを分けるだけ（serve / import-legacy / hash-password）。

use std::io::IsTerminal;
use std::time::Duration;

use anyhow::Context;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use serversystem::auth::{session, site_pass};
use serversystem::config::Config;
use serversystem::{AppState, build_app, cli, db};

/// 期限切れのセッションと合言葉を消す間隔
const PURGE_INTERVAL_SECS: u64 = 3_600;

#[derive(Parser)]
#[command(name = "serversystem", about = "serverSystem の API サーバー")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// API サーバーを起動する（起動時にマイグレーションを流す）
    Serve,
    /// 旧 auth.db から Discord と紐付いたユーザーを取り込む
    ImportLegacy(cli::import_legacy::Args),
    /// 合言葉の bcrypt ハッシュを作る
    HashPassword,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // .env は開発時（デバッグビルド）だけ読む。本番は systemd の EnvironmentFile から渡す
    if cfg!(debug_assertions) {
        let _ = dotenvy::dotenv();
    }
    init_tracing();

    match Cli::parse().command {
        Command::Serve => serve().await,
        Command::ImportLegacy(args) => cli::import_legacy::run(args).await,
        Command::HashPassword => cli::hash_password::run(),
    }
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        // journald に色の制御文字を残さないよう、端末のときだけ色を付ける
        .with_ansi(std::io::stdout().is_terminal())
        .init();
}

async fn serve() -> anyhow::Result<()> {
    let config = Config::from_env()?;
    tracing::info!(?config, "設定を読みました");

    if let Some(dir) = config.database_path.parent()
        && !dir.as_os_str().is_empty()
    {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("DB のディレクトリを作れませんでした: {}", dir.display()))?;
    }
    let pool = db::connect(&config.database_path).await?;
    db::migrate(&pool).await?;

    let listen = config.listen;
    let state = AppState::for_production(config, pool.clone()).await?;

    let purge = tokio::spawn(purge_loop(state.clone()));

    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("{listen} で待ち受けられませんでした"))?;
    tracing::info!(%listen, "待ち受けを始めました");

    axum::serve(listener, build_app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("サーバーが異常終了しました")?;

    purge.abort();
    // WAL の内容を書き戻してから閉じる
    pool.close().await;
    tracing::info!("停止しました");
    Ok(())
}

/// 1 時間ごとに、期限切れのセッションと合言葉を消す（起動直後にも 1 回流れる）
async fn purge_loop(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(PURGE_INTERVAL_SECS));
    loop {
        interval.tick().await;
        let now = state.clock.now();
        match session::purge_expired_sessions(&state.db, now).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "期限切れのセッションを消しました"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "セッションの掃除に失敗しました"),
        }
        match site_pass::purge_expired_site_passes(&state.db, now).await {
            Ok(n) if n > 0 => tracing::info!(count = n, "期限切れの合言葉を消しました"),
            Ok(_) => {}
            Err(e) => tracing::error!(error = %e, "合言葉の掃除に失敗しました"),
        }
    }
}

/// SIGTERM（systemctl stop）か Ctrl+C で、処理中のリクエストを終えてから止める
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "Ctrl+C を待てませんでした");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "SIGTERM を待てませんでした");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("停止の合図を受けました。処理中のリクエストを終えてから止めます");
}
