//! `serversystem import-legacy`：旧 auth.db から Discord と紐付いたユーザーを取り込む。
//! 決まりごとは設計書 12 §2。
//!
//! 【仮】T13 が中身を作る。引数（`Args`）もこのファイルで持つので、足すときは main.rs を触らなくてよい。

use std::path::PathBuf;

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

pub async fn run(_args: Args) -> anyhow::Result<()> {
    anyhow::bail!("未実装です")
}
