//! `serversystem import-legacy` のテスト（設計書 12 §2）。
//!
//! 旧 auth.db は、tests/fixtures/legacy/ の SQL を一時ファイルの DB に流して作る
//! （users に created_at 列が有る形と無い形の 2 つ）。

use std::path::{Path, PathBuf};

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};

use serversystem::cli::import_legacy::{self, Args, ImportReport, import_users, open_legacy};
use serversystem::db;

const WITHOUT_CREATED_AT: &str = include_str!("fixtures/legacy/auth_users_without_created_at.sql");
const WITH_CREATED_AT: &str = include_str!("fixtures/legacy/auth_users_with_created_at.sql");

/// 旧 auth.db をファイルに作る。PHP（PDO）と同じく、WAL ではない普通の形にする。
async fn make_legacy(dir: &Path, name: &str, sql: &'static str) -> PathBuf {
    let path = dir.join(name);
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Delete);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(sql).execute(&pool).await.unwrap();
    pool.close().await;
    path
}

async fn make_target(dir: &Path) -> (PathBuf, SqlitePool) {
    let path = dir.join("app.db");
    let pool = db::connect(&path).await.unwrap();
    db::migrate(&pool).await.unwrap();
    (path, pool)
}

async fn users(pool: &SqlitePool) -> Vec<(i64, String, String, i64, i64)> {
    sqlx::query_as(
        "SELECT id, discord_id, display_name, created_at, last_login_at FROM users ORDER BY id",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn imports_linked_users_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = make_legacy(dir.path(), "auth.db", WITHOUT_CREATED_AT).await;
    let before = std::fs::read(&legacy_path).unwrap();
    let (_, target) = make_target(dir.path()).await;
    let legacy = open_legacy(&legacy_path).await.unwrap();

    let r = import_users(&legacy, Some(&target), false).await.unwrap();
    assert_eq!(
        r,
        ImportReport {
            imported: 3,
            skipped: 0,
            not_linked: 1,
            orphan_links: 0
        }
    );
    // id は旧 DB の値を引き継ぎ、last_login_at には discord_users.created_at が入る
    assert_eq!(
        users(&target).await,
        vec![
            (
                1,
                "100000000000000001".into(),
                "たろう".into(),
                1700000001,
                1700000001
            ),
            (
                3,
                "100000000000000003".into(),
                "はなこ".into(),
                1700000003,
                1700000003
            ),
            (
                5,
                "100000000000000005".into(),
                "じろう".into(),
                1700000005,
                1700000005
            ),
        ]
    );

    // 2 回目は全部飛ばされ、中身も変わらない
    let r2 = import_users(&legacy, Some(&target), false).await.unwrap();
    assert_eq!(r2.imported, 0);
    assert_eq!(r2.skipped, 3);
    assert_eq!(r2.not_linked, 1);
    assert_eq!(users(&target).await.len(), 3);

    legacy.close().await;
    target.close().await;
    // 旧 DB には一切書き込んでいない
    assert_eq!(std::fs::read(&legacy_path).unwrap(), before);
}

#[tokio::test]
async fn reads_users_with_created_at_column() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = make_legacy(dir.path(), "auth.db", WITH_CREATED_AT).await;
    let (_, target) = make_target(dir.path()).await;
    let legacy = open_legacy(&legacy_path).await.unwrap();

    let r = import_users(&legacy, Some(&target), false).await.unwrap();
    assert_eq!((r.imported, r.skipped, r.not_linked), (2, 0, 2));
    // 日時は users.created_at（文字列）ではなく discord_users.created_at を使う
    assert_eq!(
        users(&target).await,
        vec![
            (
                10,
                "200000000000000010".into(),
                "Alice".into(),
                1710000010,
                1710000010
            ),
            (
                11,
                "200000000000000011".into(),
                "ボブ".into(),
                1710000011,
                1710000011
            ),
        ]
    );
    legacy.close().await;
    target.close().await;
}

#[tokio::test]
async fn skips_rows_whose_id_or_discord_id_already_exist() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = make_legacy(dir.path(), "auth.db", WITHOUT_CREATED_AT).await;
    let (_, target) = make_target(dir.path()).await;
    // 切り替えのあとに新しくログインした人（discord_id が同じで id が違う）と、
    // id だけがぶつかる別の人
    sqlx::query(
        "INSERT INTO users (id, discord_id, display_name, created_at, last_login_at) VALUES
            (100, '100000000000000001', '新しい名前', 1800000000, 1800000000),
            (3, '999', '別の人', 1800000000, 1800000000)",
    )
    .execute(&target)
    .await
    .unwrap();
    let legacy = open_legacy(&legacy_path).await.unwrap();

    let r = import_users(&legacy, Some(&target), false).await.unwrap();
    assert_eq!((r.imported, r.skipped), (1, 2));
    let rows = users(&target).await;
    assert_eq!(rows.len(), 3);
    // 既にある行は上書きしない
    assert!(rows.contains(&(3, "999".into(), "別の人".into(), 1800000000, 1800000000)));
    assert!(rows.contains(&(
        100,
        "100000000000000001".into(),
        "新しい名前".into(),
        1800000000,
        1800000000
    )));
    assert!(rows.iter().any(|r| r.0 == 5));
    legacy.close().await;
    target.close().await;
}

#[tokio::test]
async fn dry_run_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = make_legacy(dir.path(), "auth.db", WITHOUT_CREATED_AT).await;
    let (_, target) = make_target(dir.path()).await;
    let legacy = open_legacy(&legacy_path).await.unwrap();

    let r = import_users(&legacy, Some(&target), true).await.unwrap();
    assert_eq!((r.imported, r.skipped, r.not_linked), (3, 0, 1));
    assert!(users(&target).await.is_empty());

    // 取り込み先がまだ無いときも数を出せる
    let r = import_users(&legacy, None, true).await.unwrap();
    assert_eq!((r.imported, r.skipped, r.not_linked), (3, 0, 1));
    legacy.close().await;
    target.close().await;
}

#[tokio::test]
async fn run_command_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = make_legacy(dir.path(), "auth.db", WITHOUT_CREATED_AT).await;
    let before = std::fs::read(&legacy_path).unwrap();
    let target_path = dir.path().join("new").join("app.db");
    std::fs::create_dir_all(target_path.parent().unwrap()).unwrap();

    // dry-run は取り込み先のファイルを作らない
    import_legacy::run(Args {
        auth_db: legacy_path.clone(),
        db: Some(target_path.clone()),
        dry_run: true,
    })
    .await
    .unwrap();
    assert!(!target_path.exists());

    // 本番の流し方：取り込み先が無ければ作ってマイグレーションしてから取り込む。2 回流してよい
    for _ in 0..2 {
        import_legacy::run(Args {
            auth_db: legacy_path.clone(),
            db: Some(target_path.clone()),
            dry_run: false,
        })
        .await
        .unwrap();
    }
    let target = db::connect(&target_path).await.unwrap();
    assert_eq!(users(&target).await.len(), 3);
    target.close().await;
    assert_eq!(std::fs::read(&legacy_path).unwrap(), before);
}

#[tokio::test]
async fn missing_legacy_db_is_an_error_and_not_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nothing.db");
    assert!(open_legacy(&path).await.is_err());
    assert!(!path.exists());
}
