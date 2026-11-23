//! ミドルウェア。どのパスにかかるかは `routes/mod.rs` の 1 か所で決める。

pub mod csrf;
pub mod rate_limit;
pub mod site_gate;
