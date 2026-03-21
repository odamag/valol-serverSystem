# データベース設計書

## 概要
このドキュメントは、ログイン機能を実装するために必要なデータベーステーブルの設計を記述します。

## テーブル設計

### users テーブル

| カラム名 | 型 | 必須 | 説明 |
|----------|----|------|------|
| id | INTEGER | YES | ユーザーの固有ID（自動採番） |
| user_id | VARCHAR(50) | YES | ログイン用のユーザーID（重複不可） |
| username | VARCHAR(100) | YES | ユーザーの表示名 |
| otp_secret | VARCHAR(32) | YES | OTP認証用のシークレットキー |
| created_at | DATETIME | YES | アカウント作成日時 |
| updated_at | DATETIME | YES | 最終更新日時 |

## テーブル作成SQL

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id VARCHAR(50) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL,
    otp_secret VARCHAR(32) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## インデックス

```sql
-- ユーザーIDでの検索用インデックス
CREATE INDEX idx_users_user_id ON users(user_id);

-- 作成日時での検索用インデックス
CREATE INDEX idx_users_created_at ON users(created_at);
```

## 説明

- `id`: ユニークなユーザー識別子として使用されます。
- `user_id`: ログイン時に使用される識別子で、一意である必要があります。
- `username`: ユーザーが設定する表示名です。
- `otp_secret`: OTP認証に必要なシークレットキーです。Base32形式で保存されます。
- `created_at` と `updated_at`: レコードの作成日時と更新日時を管理します。

## 注意事項

1. `user_id` は一意である必要があります（重複不可）
2. `otp_secret` はセキュリティ上重要な情報なので、適切に管理する必要があります
3. 日付関連のカラムは自動的に現在日時で更新されます