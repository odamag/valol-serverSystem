//! 判断や計算の置き場所。`routes/` は入力を受け取ってここを呼び、JSON を返すだけにする。
//! 外に出る呼び出しは、ベース URL を設定で差し替えられるようにするか、trait の後ろに隠す。

pub mod game_servers;
pub mod lol_streak;
pub mod running_relay;
