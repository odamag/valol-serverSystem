//! 乱数トークンの生成とハッシュ（`sid`・`site_pass`・`oauth_state` で共用）。
//!
//! DB には値そのものではなく SHA-256 だけを保存する。DB が漏れても、
//! そのままではセッションに使えないようにするため。
//! トークンは 256 ビットの乱数なので、総当たりに強くするための遅いハッシュ（bcrypt 等）は要らない。

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// トークンの乱数のバイト数
pub const TOKEN_BYTES: usize = 32;

/// 32 バイトの乱数 → base64url（パディングなし、43 文字）
pub fn new_token() -> String {
    let mut buf = [0u8; TOKEN_BYTES];
    // ThreadRng は OS の乱数で種をまいた暗号論的な乱数生成器
    rand::fill(&mut buf[..]);
    URL_SAFE_NO_PAD.encode(buf)
}

/// SHA-256（32 バイト）
pub fn hash_token(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_43_chars_base64url_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 43);
        assert!(
            a.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_ne!(a, b);
    }

    #[test]
    fn hash_is_32_bytes_and_stable() {
        let h = hash_token("abc");
        assert_eq!(h.len(), 32);
        assert_eq!(h, hash_token("abc"));
        assert_eq!(
            hex::encode(&h),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
