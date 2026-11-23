# site フィクスチャ

`hash.txt` は、PHP の `password_hash` が作った bcrypt ハッシュ（`$2y$`）です。
今の本番が使う形式（`$2y$`）を、Rust の `bcrypt::verify` が読めることを確かめるのに使います。
合言葉は `テスト用合言葉` です（本番の合言葉ではありません）。

作ったコマンド:

```
php -r 'echo password_hash("テスト用合言葉", PASSWORD_BCRYPT);'
```
