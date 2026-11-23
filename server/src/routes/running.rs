//! /api/v1/running/*（ランニングの中継）。
//!
//! 【仮】T16 が中身を作る。ルータは `/api/v1/running/{*rest}` をすべてのメソッドでここに渡すので、
//! ホワイトリスト（メソッドが違えば 405、パスが無ければ 404）はこのハンドラで確かめる。
//! ログイン必須なので `CurrentUser` を引数に置くこと。

use axum::response::Response;

use super::not_implemented;

/// /api/v1/running/{*rest}（すべてのメソッド）。【仮】
pub async fn relay() -> Response {
    not_implemented()
}
