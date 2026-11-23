//! `serversystem hash-password`：合言葉の bcrypt ハッシュを作る（generate_hash.php の代わり）。
//!
//! 合言葉は標準入力から読む（引数に書くとシェルの履歴に残るため）。端末から打つときは、
//! 画面に出ないよう一時的にエコーを切る。パイプで渡してもよい。

use std::io::{BufRead, IsTerminal, Write};

use anyhow::Context;

pub fn run() -> anyhow::Result<()> {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    if interactive {
        eprint!("合言葉を入力してください（画面には表示されません）: ");
        std::io::stderr().flush().ok();
    }
    let echo = if interactive { EchoOff::new() } else { None };
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    drop(echo);
    if interactive {
        eprintln!();
    }
    read.context("標準入力を読めませんでした")?;
    let password = line.trim_end_matches(['\r', '\n']);
    println!("{}", hash(password)?);
    Ok(())
}

fn hash(password: &str) -> anyhow::Result<String> {
    anyhow::ensure!(!password.is_empty(), "合言葉が空です");
    // PHP の password_hash と同じ $2y$ で出す（どちらの実装でも照合できる）
    bcrypt::hash_with_result(password, bcrypt::DEFAULT_COST)
        .map(|h| h.format_for_version(bcrypt::Version::TwoY))
        .context("ハッシュを作れませんでした")
}

/// 入力中のエコーを切り、drop で戻す（Unix の端末のみ。それ以外では何もしない）。
struct EchoOff;

impl EchoOff {
    fn new() -> Option<EchoOff> {
        #[cfg(unix)]
        {
            let ok = std::process::Command::new("stty")
                .arg("-echo")
                .status()
                .is_ok_and(|s| s.success());
            ok.then_some(EchoOff)
        }
        #[cfg(not(unix))]
        {
            None
        }
    }
}

impl Drop for EchoOff {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("stty").arg("echo").status();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_verifies_and_is_2y() {
        let h = hash("あいことば").unwrap();
        assert!(h.starts_with("$2y$"));
        assert!(bcrypt::verify("あいことば", &h).unwrap());
        assert!(!bcrypt::verify("ちがう", &h).unwrap());
    }

    #[test]
    fn empty_is_rejected() {
        assert!(hash("").is_err());
    }
}
