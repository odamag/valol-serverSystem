# データベース設計書

## 概要
このシステムは、ユーザー認証機能を提供するためのSQLiteデータベースを設計しています。認証方式はOTP（ワンタイムパスワード）のみを使用し、OTP生成にはHMAC-SHA1アルゴリズムを採用します。

## テーブル設計

### usersテーブル
ユーザー情報を格納するテーブルです。

| カラム名 | 型 | 必須 | 説明 |
|----------|----|------|------|
| id | INTEGER | YES | ユーザーの固有ID（自動採番） |
| user_id | TEXT | YES | ログインに使用するユーザーID（ユニーク） |
| username | TEXT | YES | ユーザー名 |
| otp_secret | TEXT | YES | OTP生成用のシークレットキー（HMAC-SHA1） |
| created_at | DATETIME | YES | アカウント作成日時 |
| updated_at | DATETIME | YES | 最終更新日時 |

### sessionsテーブル
ユーザーのセッション情報を格納するテーブルです。

| カラム名 | 型 | 必須 | 説明 |
|----------|----|------|------|
| session_id | TEXT | YES | セッションID（UUID） |
| user_id | INTEGER | YES | 関連するユーザーのID |
| expires_at | DATETIME | YES | セッションの有効期限 |
| created_at | DATETIME | YES | セッション作成日時 |

## OTP生成アルゴリズム
- アルゴリズム：HMAC-SHA1
- シークレットキー：usersテーブルのotp_secretカラムに保存
- 有効期間：30秒（標準的なTOTP仕様）
- データベースにはシークレットキーのみを保存し、OTPは生成時に計算

## セキュリティ対策
1. データベースファイルは/db-folderフォルダーに配置され、.htaccessにより外部アクセスが禁止される
2. シークレットキーは平文で保存（OTP生成のため）
3. セッション情報は有効期限付きで管理
4. SQLインジェクション対策としてプレースホルダを使用

## データベースファイルパス
- データベースファイル：/db-folder/auth.db