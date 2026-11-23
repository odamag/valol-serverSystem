//! `serversystem import-legacy`：旧 auth.db から Discord と紐付いたユーザーを取り込む。
//! 決まりごとは設計書 12 §2。
//!
//! - 旧 DB は読み取り専用（`mode=ro`）で開き、一切書き込まない。
//! - `id` か `discord_id` が既に app.db にある行は飛ばす（何度流しても壊れない）。
//! - 旧 `users` は作られた時期で列が違う（`created_at` が有ったり無かったり）ので、
//!   `users` からは `id` と `username` だけを読み、日時は `discord_users.created_at` を使う。
//! - `--dry-run` のときは app.db に一切書かず（マイグレーションも流さず）、数だけ出す。

use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use crate::db;

#[derive(clap::Args, Debug)]
pub struct Args {
    /// 旧 auth.db のパス（読み取り専用で開く）
    #[arg(long)]
    pub auth_db: PathBuf,
    /// 取り込み先の app.db のパス（省略時は環境変数 APP_DATABASE_PATH）
    #[arg(long)]
    pub db: Option<PathBuf>,
    /// 書き込まずに件数だけ表示する
    #[arg(long)]
    pub dry_run: bool,
}

/// 取り込みの結果の数
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImportReport {
    /// 取り込んだ数（`--dry-run` のときは「取り込むはずの数」）
    pub imported: u64,
    /// `id` か `discord_id` が既にあったので飛ばした数
    pub skipped: u64,
    /// Discord と紐付いていないので対象外にした旧 users の数（OTP だけのユーザー）
    pub not_linked: u64,
    /// 旧 discord_users のうち、紐付け先の users の行が無いもの（取り込めない。ふつうは 0）
    pub orphan_links: u64,
}

/// 旧 DB から読む 1 行
struct LegacyRow {
    id: i64,
    discord_id: String,
    username: String,
    created_at: i64,
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    let target_path = match args.db {
        Some(p) => p,
        None => PathBuf::from(
            std::env::var("APP_DATABASE_PATH")
                .context("--db か環境変数 APP_DATABASE_PATH で取り込み先を指定してください")?,
        ),
    };

    let legacy = open_legacy(&args.auth_db).await?;

    let report = if args.dry_run {
        // 書き込まないので、取り込み先も読み取り専用で開く（無ければ空の DB とみなす）
        let target = if target_path.exists() {
            Some(open_read_only(&target_path).await?)
        } else {
            None
        };
        let r = import_users(&legacy, target.as_ref(), true).await?;
        if let Some(t) = target {
            t.close().await;
        }
        r
    } else {
        let target = db::connect(&target_path).await?;
        // serve を一度も起動していない DB にも取り込めるよう、先にマイグレーションを流す
        db::migrate(&target).await?;
        let r = import_users(&legacy, Some(&target), false).await?;
        target.close().await;
        r
    };
    legacy.close().await;

    let head = if args.dry_run {
        "【dry-run：書き込んでいません】"
    } else {
        ""
    };
    println!(
        "{head}取り込んだ数: {} / 飛ばした数（既にある）: {} / 対象外（Discord と紐付いていない）: {}",
        report.imported, report.skipped, report.not_linked
    );
    if report.orphan_links > 0 {
        println!(
            "注意: users の行が無い discord_users が {} 件あり、取り込めませんでした",
            report.orphan_links
        );
    }
    Ok(())
}

/// 旧 auth.db を読み取り専用で開く。無いファイルは作らずにエラーにする。
pub async fn open_legacy(path: &Path) -> anyhow::Result<SqlitePool> {
    if !path.exists() {
        bail!("旧 auth.db が見つかりません: {}", path.display());
    }
    open_read_only(path).await
}

/// 読み取り専用（SQLITE_OPEN_READONLY ＝ `mode=ro`）で開く。
async fn open_read_only(path: &Path) -> anyhow::Result<SqlitePool> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .create_if_missing(false);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .with_context(|| format!("DB を読み取り専用で開けませんでした: {}", path.display()))
}

/// 取り込みの本体（テストから直接呼べるよう公開している）。
///
/// - `target` が `None` なのは、`--dry-run` で取り込み先のファイルがまだ無いときだけ（空とみなす）。
/// - `dry_run` が true なら `target` には読むだけで書かない。
pub async fn import_users(
    legacy: &SqlitePool,
    target: Option<&SqlitePool>,
    dry_run: bool,
) -> anyhow::Result<ImportReport> {
    if target.is_none() && !dry_run {
        bail!("取り込み先の DB がありません");
    }
    let rows = read_legacy_rows(legacy).await?;
    let not_linked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users u
          WHERE NOT EXISTS (SELECT 1 FROM discord_users du WHERE du.user_id = u.id)",
    )
    .fetch_one(legacy)
    .await
    .context("旧 users を数えられませんでした")?;
    let orphan_links: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM discord_users du
          WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = du.user_id)",
    )
    .fetch_one(legacy)
    .await
    .context("旧 discord_users を数えられませんでした")?;

    let mut report = ImportReport {
        not_linked: not_linked as u64,
        orphan_links: orphan_links as u64,
        ..Default::default()
    };

    let Some(target) = target else {
        // 取り込み先がまだ無い（dry-run）：全部取り込めるはず
        report.imported = rows.len() as u64;
        return Ok(report);
    };
    // dry-run のときは、マイグレーション前の DB（users が無い）も空とみなす
    if dry_run && !has_users_table(target).await? {
        report.imported = rows.len() as u64;
        return Ok(report);
    }

    // 全部取り込むか、何も取り込まないかのどちらかにする（途中で失敗しても半端に残さない）。
    // トランザクションの中のクエリは全部 tx を通す（テストの 1 本だけの接続で詰まらないように）
    let mut tx = target
        .begin()
        .await
        .context("トランザクションを始められませんでした")?;
    for row in &rows {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM users WHERE id = ? OR discord_id = ? LIMIT 1")
                .bind(row.id)
                .bind(&row.discord_id)
                .fetch_optional(&mut *tx)
                .await
                .context("取り込み先の users を確かめられませんでした")?;
        if exists.is_some() {
            report.skipped += 1;
            continue;
        }
        if !dry_run {
            sqlx::query(
                "INSERT INTO users (id, discord_id, display_name, created_at, last_login_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(row.id)
            .bind(&row.discord_id)
            .bind(&row.username)
            .bind(row.created_at)
            // 旧 DB には最後のログインの日時が無いので、紐付けた日時を入れる（12 §2）
            .bind(row.created_at)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("users.id={} を取り込めませんでした", row.id))?;
        }
        report.imported += 1;
    }
    if dry_run {
        tx.rollback().await.context("ロールバックに失敗しました")?;
    } else {
        tx.commit().await.context("コミットに失敗しました")?;
    }
    Ok(report)
}

/// 旧 DB から、Discord と紐付いたユーザーを読む（12 §2 の SELECT）。
/// 型の揺れ（discord_id が数値で入っている等）に備えて、SQL の中で型をそろえる。
async fn read_legacy_rows(legacy: &SqlitePool) -> anyhow::Result<Vec<LegacyRow>> {
    let rows: Vec<(i64, String, String, i64)> = sqlx::query_as(
        "SELECT u.id, CAST(du.discord_id AS TEXT), CAST(u.username AS TEXT),
                CAST(du.created_at AS INTEGER)
           FROM discord_users du JOIN users u ON u.id = du.user_id
          ORDER BY u.id",
    )
    .fetch_all(legacy)
    .await
    .context("旧 auth.db の users / discord_users を読めませんでした")?;
    Ok(rows
        .into_iter()
        .map(|(id, discord_id, username, created_at)| LegacyRow {
            id,
            discord_id,
            username,
            created_at,
        })
        .collect())
}

async fn has_users_table(db: &SqlitePool) -> anyhow::Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'",
    )
    .fetch_one(db)
    .await
    .context("取り込み先の DB を確かめられませんでした")?;
    Ok(n > 0)
}
