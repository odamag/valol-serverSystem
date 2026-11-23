//! CSRF 対策の Origin の確認（設計書 10 §5）。
//!
//! GET・HEAD・OPTIONS 以外では、`Origin` が `APP_PUBLIC_ORIGIN` と完全に一致しなければ 403。
//! `Origin` が無いときは `Referer` が `APP_PUBLIC_ORIGIN/` で始まるかを見る。どちらも無ければ 403。
//! （SameSite=Lax の Cookie と合わせて二重に守る。どちらかの設定を間違えても穴にならないように）

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::state::AppState;

pub async fn check_origin(State(s): State<AppState>, req: Request, next: Next) -> Response {
    if is_safe_method(req.method()) || origin_allowed(req.headers(), &s.config.public_origin) {
        next.run(req).await
    } else {
        // メソッドとパスは TraceLayer の span に入っているので、ここでは書かない
        tracing::warn!("Origin が一致しないので拒否しました");
        AppError::Forbidden("不正なリクエストです".to_owned()).into_response()
    }
}

fn is_safe_method(m: &Method) -> bool {
    *m == Method::GET || *m == Method::HEAD || *m == Method::OPTIONS
}

/// `public_origin` は末尾の `/` を取り除いた形（Config がそうしている）
fn origin_allowed(headers: &HeaderMap, public_origin: &str) -> bool {
    if let Some(origin) = headers.get("origin") {
        // Origin があれば、それだけで決める（"null" や別のオリジンなら Referer は見ない）
        return origin.to_str().is_ok_and(|o| o == public_origin);
    }
    if let Some(referer) = headers.get("referer") {
        // "https://example.com.evil.com/" を通さないよう、"/" まで含めて比べる
        return referer.to_str().is_ok_and(|r| {
            r == public_origin
                || r.strip_prefix(public_origin)
                    .is_some_and(|rest| rest.starts_with('/'))
        });
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const O: &str = "https://example.com";

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, v.parse().unwrap());
        }
        m
    }

    #[test]
    fn origin_rules() {
        assert!(origin_allowed(&h(&[("origin", O)]), O));
        assert!(!origin_allowed(&h(&[("origin", "https://evil.com")]), O));
        assert!(!origin_allowed(&h(&[("origin", "null")]), O));
        assert!(!origin_allowed(
            &h(&[("origin", "https://example.com/")]),
            O
        ));
        // Origin が違えば、Referer が正しくても通さない
        assert!(!origin_allowed(
            &h(&[
                ("origin", "https://evil.com"),
                ("referer", "https://example.com/x")
            ]),
            O
        ));
        assert!(origin_allowed(
            &h(&[("referer", "https://example.com/server")]),
            O
        ));
        assert!(origin_allowed(&h(&[("referer", "https://example.com")]), O));
        assert!(!origin_allowed(
            &h(&[("referer", "https://example.com.evil.com/")]),
            O
        ));
        assert!(!origin_allowed(
            &h(&[("referer", "https://example.comx")]),
            O
        ));
        assert!(!origin_allowed(&h(&[]), O));
    }
}
