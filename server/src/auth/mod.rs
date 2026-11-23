//! 認証まわり（合言葉・ログインセッション・Discord OAuth）。
//!
//! Cookie の属性はここの [`build_cookie`] / [`removal_cookie`] でだけ決める。
//! 属性（HttpOnly・Secure・SameSite=Lax）の付け忘れを防ぐため、Cookie を作るときは必ずこれを通す。

pub mod discord;
pub mod session;
pub mod site_pass;
pub mod token;

use axum::http::HeaderMap;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};

use crate::config::Config;

/// `HttpOnly; Secure; SameSite=Lax; Path=<path>; Max-Age=<max_age_secs>` の Cookie を作る。
/// `Secure` は `APP_COOKIE_SECURE`（開発時だけ false）に従う。
///
/// 例：`oauth_state` は `build_cookie("oauth_state", &state, "/api/v1/auth/discord", Some(600), config)`
pub fn build_cookie(
    name: &'static str,
    value: &str,
    path: &'static str,
    max_age_secs: Option<i64>,
    config: &Config,
) -> Cookie<'static> {
    let mut cookie = Cookie::build((name, value.to_owned()))
        .http_only(true)
        .secure(config.cookie_secure)
        .same_site(SameSite::Lax)
        .path(path)
        .build();
    if let Some(secs) = max_age_secs {
        // cookie クレートの Max-Age は time::Duration で、time を直接の依存にしていないため、
        // 文字列から読ませて同じ値を作る
        let parsed = Cookie::parse(format!("x=y; Max-Age={secs}")).expect("固定の形式");
        cookie.set_max_age(parsed.max_age());
    }
    cookie
}

/// Cookie を消すための Cookie（値を空にし、Max-Age=0 と過去の Expires を付ける）。
/// `path` は作ったときと同じにする（違うとブラウザは別の Cookie とみなして消さない）。
pub fn removal_cookie(name: &'static str, path: &'static str, config: &Config) -> Cookie<'static> {
    let mut cookie = build_cookie(name, "", path, None, config);
    cookie.make_removal();
    cookie
}

/// リクエストの Cookie ヘッダから、名前で値を取り出す。空の値は無いのと同じに扱う。
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    CookieJar::from_headers(headers)
        .get(name)
        .map(|c| c.value().to_owned())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_attributes() {
        let config = Config::for_test();
        let c = build_cookie(
            "oauth_state",
            "abc",
            "/api/v1/auth/discord",
            Some(600),
            &config,
        );
        let s = c.to_string();
        assert!(s.starts_with("oauth_state=abc"));
        assert!(s.contains("HttpOnly"));
        assert!(s.contains("Secure"));
        assert!(s.contains("SameSite=Lax"));
        assert!(s.contains("Path=/api/v1/auth/discord"));
        assert!(s.contains("Max-Age=600"));
    }

    #[test]
    fn secure_follows_config() {
        let mut config = Config::for_test();
        config.cookie_secure = false;
        let s = build_cookie("sid", "abc", "/", None, &config).to_string();
        assert!(!s.contains("Secure"));
    }

    #[test]
    fn removal_cookie_expires() {
        let config = Config::for_test();
        let s = removal_cookie("sid", "/", &config).to_string();
        assert!(s.starts_with("sid=;"));
        assert!(s.contains("Max-Age=0"));
        assert!(s.contains("Path=/"));
    }

    #[test]
    fn reads_cookie_value() {
        let mut h = HeaderMap::new();
        h.insert("cookie", "a=1; sid=xyz; site_pass=".parse().unwrap());
        assert_eq!(cookie_value(&h, "sid").as_deref(), Some("xyz"));
        assert_eq!(cookie_value(&h, "site_pass"), None);
        assert_eq!(cookie_value(&h, "none"), None);
    }
}
