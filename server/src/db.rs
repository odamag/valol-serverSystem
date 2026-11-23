//! DB の接続とマイグレーション（設計書 10 §6.4）。
//!
//! クエリは実行時に確かめる書き方（`sqlx::query` / `query_as::<_, T>()`）にする。
//! コンパイル時に確かめるマクロ（`query!`）は、ビルドに DB が要るので使わない。
//! 値は必ずバインド変数（`?`）で渡し、SQL の文字列に埋め込まない。

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use anyhow::Context;
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

/// プールの最大接続数（SQLite は書き込みが 1 本ずつなので、多くしても速くならない）
pub const MAX_CONNECTIONS: u32 = 5;

/// 接続するたびに設定する PRAGMA。
/// foreign_keys は接続ごとの設定なので、プールの全接続にかける必要がある。
fn base_options(options: SqliteConnectOptions) -> SqliteConnectOptions {
    options
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(5))
        .synchronous(SqliteSynchronous::Normal)
}

/// 本番用。ファイルが無ければ作る。
pub async fn connect(path: &Path) -> anyhow::Result<SqlitePool> {
    let options = base_options(
        SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true),
    );
    SqlitePoolOptions::new()
        .max_connections(MAX_CONNECTIONS)
        .connect_with(options)
        .await
        .with_context(|| format!("DB を開けませんでした: {}", path.display()))
}

/// テスト用のメモリ上の DB。
///
/// メモリ上の SQLite は接続ごとに別の DB になるため、接続は 1 本だけにして、
/// 捨てられないようにする。そのため、テストでは「トランザクションを持ったまま、
/// 別に `&SqlitePool` でクエリを流す」と接続の取り合いになり、5 秒で失敗する
/// （本番でもトランザクションの外で書くことになるので、どのみち誤り）。
pub async fn connect_in_memory() -> anyhow::Result<SqlitePool> {
    let options = base_options(SqliteConnectOptions::from_str("sqlite::memory:")?);
    SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .idle_timeout(None)
        .max_lifetime(None)
        .acquire_timeout(Duration::from_secs(5))
        .connect_with(options)
        .await
        .context("メモリ上の DB を開けませんでした")
}

/// `migrations/` の SQL を流す（バイナリに埋め込まれている）。
pub async fn migrate(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .context("マイグレーションに失敗しました")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pragmas_and_migration() {
        let dir = tempfile::tempdir().unwrap();
        let pool = connect(&dir.path().join("app.db")).await.unwrap();
        migrate(&pool).await.unwrap();
        // 2 回流しても壊れない
        migrate(&pool).await.unwrap();

        let fk: i64 = sqlx::query_scalar("PRAGMA foreign_keys")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(fk, 1);
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode, "wal");
        let busy: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(busy, 5000);
        let tables: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(tables, ["sessions", "site_passes", "users"]);
        pool.close().await;
    }
}
