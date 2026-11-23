//! API のエラー（設計書 10 §6.3）。
//!
//! 応答はすべて `{"success": false, "message": "<日本語>"}` とステータスコード。
//! `message` はそのまま画面に出るので、内部の事情（AWS や SQL のエラー文）は書かない。
//! `Internal` と `Upstream` は元のエラーをログにだけ出す。

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(thiserror::Error, Debug)]
pub enum AppError {
    /// 400
    #[error("{0}")]
    BadRequest(String),
    /// 401（合言葉が無い・切れている）
    #[error("サイト認証が必要です")]
    SiteAuthRequired,
    /// 401（ログインが無い・切れている）
    #[error("認証が必要です")]
    LoginRequired,
    /// 403
    #[error("{0}")]
    Forbidden(String),
    /// 404
    #[error("見つかりません")]
    NotFound,
    /// 409（例：起動処理中）
    #[error("{0}")]
    Conflict(String),
    /// 429
    #[error("しばらく待ってからお試しください")]
    TooManyRequests,
    /// 502（外部サービスの失敗）
    #[error("外部サービスに接続できませんでした")]
    Upstream(#[source] anyhow::Error),
    /// 500
    #[error("サーバーエラーが発生しました")]
    Internal(#[source] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::SiteAuthRequired | AppError::LoginRequired => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::NotFound => StatusCode::NOT_FOUND,
            AppError::Conflict(_) => StatusCode::CONFLICT,
            AppError::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
            AppError::Upstream(_) => StatusCode::BAD_GATEWAY,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        // 元のエラーは利用者に見せず、ログにだけ残す（原因の連鎖も {:#} で出す）
        match &self {
            AppError::Upstream(e) => {
                tracing::error!(error = format!("{e:#}"), "外部サービスのエラー")
            }
            AppError::Internal(e) => tracing::error!(error = format!("{e:#}"), "内部エラー"),
            _ => {}
        }
        let body = json!({ "success": false, "message": self.to_string() });
        (self.status(), Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn internal_error_hides_detail() {
        let res = AppError::Internal(anyhow::anyhow!("秘密の詳細")).into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            v,
            json!({"success": false, "message": "サーバーエラーが発生しました"})
        );
    }

    #[test]
    fn statuses() {
        assert_eq!(
            AppError::SiteAuthRequired.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            AppError::TooManyRequests.status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            AppError::Upstream(anyhow::anyhow!("x")).status(),
            StatusCode::BAD_GATEWAY
        );
    }
}
