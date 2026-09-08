# ランニング記録 API 契約

Lambda 側（`aws/src/`）・PHP プロキシ側（`api/running/`）・React 側（`frontend/src/`）が
別々に実装されるため、three-way で食い違わないように「越境する部分」だけをここに固定する。
**このファイルと実装が食い違ったら、実装ではなくこのファイルを先に直すこと。**

内部設計（DynamoDB のキー設計、Elo 相当のロジック等）はここには書かない。

---

## 1. レスポンスの共通形式

AWS 側も**必ず**この形で返す。PHP プロキシはこれをそのまま透過するだけで、
フィールドのマッピングを一切しない（既存の `api/arena/` と同じ規約に揃えるため）。

```jsonc
// 成功
{ "success": true, ... }
// 失敗（message は必ず日本語。そのままユーザーに表示される）
{ "success": false, "message": "距離は 0.1km 以上で指定してください" }
```

HTTP ステータスも意味のある値を返す（400 / 401 / 403 / 404 / 409 / 500）。
`frontend/src/lib/runningApi.js` は `!res.ok || data.success === false` を
`RunningApiError(message, status, payload)` として throw する。

---

## 2. PHP → AWS の HMAC 署名（**ズレると全リクエストが 401 になる**）

canonical string は改行 `\n` 区切りで、この順序で連結する。

```
method \n path \n query \n discordId \n ts \n nonce \n sha256hex(body)
```

| 要素 | PHP 側（送信） | Lambda 側（検証） |
|---|---|---|
| `method` | `$_SERVER['REQUEST_METHOD']` | `event.requestContext.http.method` |
| `path` | `runningResolvePath()` の戻り値（例 `/v1/records`） | **`event.rawPath`** |
| `query` | `http_build_query($_GET - path)`。空なら空文字 | **`event.rawQueryString`**（未定義なら空文字） |
| `discordId` | セッションから引いた値 | `X-Run-Discord-Id` ヘッダ |
| `ts` | `time()` の10進文字列 | `X-Run-Ts` ヘッダ |
| `nonce` | `bin2hex(random_bytes(16))`（32桁hex） | `X-Run-Nonce` ヘッダ |
| body hash | `hash('sha256', $body)` | 生ボディの sha256 hex |

- 署名 = `HMAC-SHA256(canonical, sharedSecret)` を **小文字 hex** で `X-Run-Signature` に入れる
- 比較は Lambda 側で `crypto.timingSafeEqual`（長さ不一致なら先に false）
- GET / DELETE はボディを送らないので `sha256('')` になる
- `path` は API Gateway の**デフォルトステージ**を使うためステージ名の接頭辞が付かない

### リプレイ対策（Lambda 側）
1. `|now - ts| <= 300` 秒。外れたら 401
2. `PutItem { pk: 'NONCE#<nonce>', sk: 'NONCE', ttl: now + 600 }` を
   `ConditionExpression: 'attribute_not_exists(pk)'` で実行。失敗（＝再送）したら 401
3. **1 と 2 の順序を入れ替えないこと**（先に時刻で弾かないと nonce テーブルが汚れる）

署名検証に失敗したときは**理由を返さない**（401 + 汎用メッセージ）。

---

## 3. 共通のデータ表現

| 概念 | 表現 | 例 |
|---|---|---|
| 記録 ID | `<YYYY-MM-DD>_<32桁hex>` | `2026-09-09_a1b2c3d4e5f6...` |
| 距離 | **保存はメートル整数** `distanceM` / **APIの入出力は km の小数** `distanceKm` | `5200` / `5.2` |
| 時間 | **秒整数** `durationS` | `1590` |
| ペース | **秒/km の整数** `paceSPerKm`（サーバー側で計算。入力では受け取らない） | `306` |
| 走行日 | JST の `YYYY-MM-DD` 文字列 | `2026-09-09` |
| 月 | `YYYY-MM` | `2026-09` |
| 週 | ISO週・月曜始まり `YYYY-Www` | `2026-W37` |

**丸めの規約**: `distanceKm` → `distanceM` は `Math.round(km * 1000)`。逆は `m / 1000`。
クライアントは表示のために再計算してよいが、**保存値の正はサーバー側**。

### 記録オブジェクト
```jsonc
{
  "id": "2026-09-09_a1b2c3d4e5f67890a1b2c3d4e5f67890",
  "runDate": "2026-09-09",
  "distanceKm": 5.2,
  "durationS": 1590,
  "paceSPerKm": 306,
  "memo": null, "course": null,
  "weather": null,          // sunny|cloudy|rain|snow|windy|indoor のいずれか or null
  "heartRate": null, "calories": null,
  "photoUrl": null,         // 署名付きGET URL（有効期限1時間）。写真が無ければ null
  "source": "web",          // web | discord
  "updatedAt": 1789000000   // 楽観ロック用。PATCH/DELETE でそのまま送り返す
}
```

---

## 4. エンドポイント

すべて `/v1` 始まり。PHP 側のホワイトリスト（`api/running/index.php` の `$ALLOWED`）と
**完全に一致させること**。ここに足したら向こうにも足す。

### `GET /v1/records?limit=20&cursor=<opaque>`
自分の記録一覧（新しい順）。`limit` は 1〜50、既定 20。
```jsonc
{ "success": true, "records": [ /* 記録オブジェクト */ ], "nextCursor": "..." | null }
```
`cursor` は base64url。**Lambda 側で復号後に `pk === U#<自分のdiscordId>` を検証する**。

### `POST /v1/records`
```jsonc
// リクエスト
{ "runDate": "2026-09-09",   // 省略時は JST の今日
  "distanceKm": 5.2,          // 必須。0.1〜300
  "durationS": 1590,          // 必須。1〜86400
  "memo": null, "course": null, "weather": null, "heartRate": null, "calories": null }
// レスポンス
{ "success": true, "record": { /* 記録オブジェクト */ } }
```
未知のキーが来たら **400**（`api/arena/routes/admin.php` の `arenaCheckAllowedFields()` と同じ思想）。

### `PATCH /v1/records/<id>`
リクエストは POST と同じ形の**部分更新** + `"updatedAt": <取得時の値>`（必須）。
`updatedAt` が一致しなければ **409**「他の端末で更新されました。再読み込みしてください」。

### `DELETE /v1/records/<id>?updatedAt=<値>`
成功時 `{ "success": true }`。不一致なら 409。

### `GET /v1/me/summary?month=YYYY-MM`
`month` 省略時は JST の当月。
```jsonc
{ "success": true,
  "month":  { "distanceKm": 42.5, "durationS": 13000, "runs": 8, "rank": 3 },
  "week":   { "distanceKm": 12.0, "durationS": 3700,  "runs": 2 },
  "total":  { "distanceKm": 310.2, "durationS": 95000, "runs": 61 },
  "nextThreshold": { "km": 50, "remainingKm": 7.5, "roleName": "50km達成" } | null }
```

### `GET /v1/ranking?scope=month|week|total&period=YYYY-MM&limit=20`
`scope` 既定 `month`。`period` は `scope=month` のとき `YYYY-MM`、`week` のとき `YYYY-Www`。
```jsonc
{ "success": true, "scope": "month", "period": "2026-09",
  "entries": [ { "rank": 1, "discordId": "...", "userName": "...",
                 "distanceKm": 120.5, "durationS": 36000, "runs": 20 } ],
  "me": { "rank": 3, "distanceKm": 42.5 } | null }
```
`runs === 0` の集計アイテムは**除外する**（削除で 0 になった残骸を出さないため）。
同距離の tie-break は `runs` の少ないほう（＝1回あたりが長い）を上位にする。

### `GET /v1/settings`
閾値ロールの一覧を Web 側の表示（「あと◯km」）に使う。ロールIDは返さない。
```jsonc
{ "success": true, "thresholds": [ { "km": 30, "roleName": "30km達成" } ] }
```

### `POST /v1/records/<id>/photo-url` → `POST /v1/records/<id>/photo`
Phase 4。§5 参照。

---

## 5. 画像アップロード（Phase 4）

```
1) POST /v1/records/<id>/photo-url   { "contentType": "image/jpeg" }
   → { "success": true, "upload": { "url": "...", "fields": {...} }, "key": "tmp/..." }
2) ブラウザ: FormData に fields を全部積み、**最後に** file を append して url へ POST
   （credentials は付けない。S3 は別オリジンで署名済み）
3) POST /v1/records/<id>/photo       { "key": "tmp/..." }
   → HeadObject で検証 → photos/ へ CopyObject → tmp/ を Delete → photoKey を保存
   → { "success": true, "record": { ... } }
```
- 署名付き **POST**（`createPresignedPost`）を使う。PUT では `content-length-range` による
  サイズ上限をサーバー側から強制できず、巨大ファイルを投げ込まれ放題になるため
- 条件: `['content-length-range', 1, 8*1024*1024]`、`['starts-with', '$Content-Type', 'image/']`
- 有効期限 300 秒。`tmp/` はライフサイクルで1日後に自動削除

---

## 6. Discord 側から来る場合の差分

Discord のスラッシュコマンドは PHP を経由せず WorkerFn が直接 DynamoDB を触るが、
**バリデーションと丸めの規約は上記と完全に同じ関数を共有する**こと
（`src/lib/records.ts` に集約し、`api.ts` と `worker.ts` の両方から呼ぶ）。
違いは `source` が `"discord"` になることと、`userName` に Discord の表示名が入ることだけ。
