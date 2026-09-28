# MG01 Race(アイテムレース)Web版 設計書

## 0. この文書について

- Unity 用に書いた仕様書 `BO5ArenaForUnity/BO5Arena/document/minigames/MG01_Race.md`(以下「元仕様」)を、
  **Three.js + PeerJS のブラウザゲーム**として `games/race/` に実装するための設計書。
- **最大8人**で遊べるようにする(身内の7人で遊ぶ前提)。元仕様は1対1なので、人数に関わる部分は一般化し、
  **2人のときは元仕様と同じ挙動になる** ようにする(BO5Arena に入れるときは2人に絞る)。
- 接続、名簿、切断・再接続、裏タブ対策、ロビーは全ゲーム共通の枠(`games/_shared/`)が行う。
  その約束は `document/minigame_contract.md`(以下「約束」)にある。本書はゲーム本体の設計。
- 実装は `document/race_implementation_plan.md` のタスクに分けて、サブエージェント(Sonnet)が進める。
  **各タスクは、本書と約束に書かれたファイル名・関数名・メッセージ名・座標系を変えずに実装すること。**
  変えないと進められない場合は、実装せずに理由を報告する。

## 1. 前提と方針

| 項目 | 決定 | 理由 |
|---|---|---|
| 配置場所 | `games/race/`(ゲーム本体)と `games/_shared/`(枠)。静的ファイル | 既存の `games/gungi` と同じ形。main へのマージで FTP デプロイされる |
| サーバー | **持たない**。PeerJS による P2P で、ホストのブラウザがサーバーを兼ねる | 本番のロリポップは PHP + 静的ファイルのみで、WebSocket も常駐プロセスも使えない(`arena_design.md`)。Unity の NGO も「ホストがサーバーを兼ねる」ので、元仕様の権限モデルがそのまま移る |
| 通信の形 | ゲストは全員ホストにだけつなぐ(スター型) | 8人でもホストの上りは 1Mbps 程度(9.1節) |
| ビルド | **しない**。ES Modules と importmap | gungi と同じくビルドなしで配置できる。`frontend/` の Vite には入れない |
| 描画 | Three.js `0.170.0` を jsDelivr から importmap で読む | 元仕様の見た目(プリミティブのみ)なら標準機能で足りる |
| 物理 | **物理エンジンは使わない**。自前の簡易なアーケード挙動 | 元仕様は「グリップ走行、壁は跳ね返るだけ」 |
| テスト | `node --test`(Node 20 以上。追加パッケージなし) | ロジックを DOM と Three.js から切り離し、ブラウザなしで確かめる |
| 言語 | JavaScript(ES2020)。JSDoc で型を書く。コメントとUIの文言は日本語 | リポジトリのほかのコードに合わせる |

### 1.1 Unity の要素との対応

| 元仕様 | Web版 |
|---|---|
| `RaceConfig` | `src/config.js` の `RaceConfig` |
| `MG01RaceCourseBuilder`(エディタで生成) | `src/core/course.js`。ページを開いたときにウェイポイントから生成する |
| Rigidbody | `src/core/kart.js` の `stepKart()` |
| Trigger | 距離の判定(円どうし/コース座標での矩形) |
| `OwnerNetworkTransform` | 各クライアントが自分のカートを動かして 20Hz で `kartState` を送り、ホストが全員分をまとめて `karts` で配る。受け取った側は 100ms 遅らせて補間する |
| `ServerRpc` / `ClientRpc` / `NetworkVariable` | `GameNet` で送る JSON メッセージ(9.2節) |
| サーバーがスポーンする `NetworkObject` | `RaceHost` が持つ `objects`(ID つき)。`spawnObj` / `objState` / `despawnObj` で配る |
| `CountdownGate` / `IsInputOpen` | `roundStart.startAt`(ホスト時刻) |
| `ReportResult(winner)` | 約束の `ctx.onResult({ ranking, ... })` |
| 接続・再接続(06) | 枠が行う(約束 7節) |
| UIDocument(HUD) | HTML/CSS のオーバーレイと `src/ui/hud.js` |
| Input System | `src/game/input.js`(キーボード、マウス、Gamepad API) |
| 起動引数 `-bo5-*` | URL パラメータ(11節) |
| ログ `[BO5][MG01]` | 約束の `ctx.log`(同じ接頭辞) |

### 1.2 スコープ外

- BO5Arena の枠そのもの(約束の設定だけで2人に絞れるようにしておく)。
- サウンド、アートの作り込み、チート対策、スマホのタッチ操作。

## 2. 共通の規約(全タスク共通)

### 2.1 座標系と単位

- 単位は **メートル、秒、ラジアン**。ネットワークの時刻だけはミリ秒(ホスト時刻)。
- Three.js と同じく **Y が上**。ゲームロジックは XZ 平面の2次元で計算し、Y は描画のときだけ使う。
- 向き `yaw`:0 のとき +Z を向く。**前方ベクトル = `(sin yaw, cos yaw)`**(x, z の順)。
  Three.js では `object.rotation.y = yaw` にすればそのまま合う。
- **左方向ベクトル = `(cos yaw, -sin yaw)`**。コース座標の `lateral`(横方向のずれ)は **左がプラス**。
- 入力の `steer` は **右がプラス**(-1〜1)。右に曲がると yaw は減る(`yaw += -steer * turnRate * dt`)。
- 角度は `wrapAngle()` で (-π, π] に収める。
- プレイヤーは **slot(0〜7 の整数)** で表す。枠のホストは常に slot 0。

### 2.2 コードの規約

- `src/core/`、`src/game/`(`input.js` を除く)、`src/game.js` のうちロジックの部分は **DOM・`window`・`three`・`Peer` を参照しない**。Node でそのまま import できること。
  `src/game.js` は描画と HUD を `dom` があるときだけ動的 import する(`await import('./render/renderer.js')`)。
- 時刻は引数で受け取る(`now` や `dt`)。`Date.now()` / `performance.now()` / `setTimeout` / `setInterval` をロジックの中で呼ばない。
  → ヘッドレスのシミュレーション(`tests/sim.test.js`)で時間を早送りできるようにするため。
- 乱数は `games/_shared/core/rng.js` の `createRng(seed)` だけを使う。`Math.random()` は禁止。
- 数値はすべて `RaceConfig` から読み、コードに直接書かない。
- ログは `ctx.log` を通す(10.3節)。

## 3. ファイル構成

枠(`games/_shared/`)のファイルは約束 1節と実装プランを参照。ここではゲーム本体だけを書く。

```
games/race/
  index.html            importmap、PeerJS、canvas と HUD の入れ物。standalone を起動するだけ
  style.css
  package.json          {"private": true, "type": "module", "scripts": {"test": "node --test"}}
  src/
    game.js             definition と createGame(ctx)(約束 2・3節)
    config.js           RaceConfig と makeConfig(overrides)
    core/               ── 純粋なロジック(Node で動く)
      math.js           clamp, lerp, wrapAngle, lerpAngle, forwardVec, leftVec, dist2
      courseData.js     ウェイポイント、グリッド、ブーストパッド、アイテムボックスの配置
      course.js         buildCourse(data, cfg): スプライン、投影、チェックポイント、グリッド
      kart.js           カートの状態と stepKart()
      progress.js       チェックポイント・周回・逆走・順位
      items.js          アイテムの種類と抽選
      projectiles.js    Rocket / Homing / Oil の移動(ホストが使う)と当たり判定
      autopilot.js      ボットと検証用の自動運転
    game/               ── 進行の制御(Node で動く。input.js を除く)
      protocol.js       ゲームのメッセージの種類と作成関数
      interp.js         スナップショット補間
      host.js           RaceHost(サーバー役)
      client.js         RaceClient(各プレイヤーの処理)
      input.js          キーボード、マウス、ゲームパッド(ブラウザ専用)
    render/             ── Three.js(ブラウザ専用)
      renderer.js       createRenderer(canvas, course, cfg, roster)
      courseMesh.js     道路、芝、壁、スタートライン、パッド、ボックスのメッシュ
      kartMesh.js       カートのメッシュ
      objects.js        弾・油のメッシュのプール
      camera.js         追いかけカメラと後方視点
    ui/
      hud.js            HUD の更新
  tests/
    course.test.js  kart.test.js  progress.test.js  items.test.js
    projectiles.test.js  autopilot.test.js  protocol.test.js  interp.test.js
    host.test.js  client.test.js
    sim.test.js         枠のヘッドレス版 + ボット2〜8台の対戦を早送りで回す結合テスト
  dev/
    render-preview.html / render-preview.js   描画だけを確かめるページ
```

依存の向き:`_shared/core` ← `core` ← `game/protocol` ← `game` ← `render` / `ui` ← `game.js`。逆向きの import はしない。

## 4. 設定値(`src/config.js`)

`makeConfig(overrides)` は深いマージをしたコピーを返す(元を変えない)。
`ctx.settings` はここに上書きとして渡る。値は元仕様の目安と8人対応から決めた初期値で、あとで遊んで調整する。

```js
export const RaceConfig = {
  laps: 2,
  timeLimitSec: 180,
  countdownSec: 3,
  startDelaySec: 1,                // createGame からカウントダウン開始までの余裕(全員の生成を待つ)
  fixedDt: 1 / 60,

  finishRule: 'grace',             // 'grace' | 'first'(約束 5節)
  finishGraceSec: 15,              // 'grace' のとき、1位のゴールからこの秒数で打ち切る

  colors: [0x3b82f6, 0xef4444, 0x22c55e, 0xeab308, 0xa855f7, 0xf97316, 0x06b6d4, 0xec4899],
                                   // slot の順。0=青、1=赤(元仕様の A/B と同じ)

  kart: {
    maxSpeed: 26,                  // m/s(約94km/h)
    accel: 16,
    brakeDecel: 32,
    reverseMaxSpeed: 8,
    reverseAccel: 10,
    coastDecel: 5,
    overSpeedDecel: 20,            // 最高速度を超えているときに落とす速さ(芝に入ったときなど)
    offroadMaxFactor: 0.5,         // 芝での最高速度の倍率(元仕様4節)
    turnRateLow: 2.6,
    turnRateHigh: 1.6,
    turnFullSpeed: 4,
    radius: 1.1,
    wallRestitution: 0.5,
    wallSpeedKeep: 0.9,
    kartPushSpeedKeep: 0.95,
  },

  boost: { accelMul: 1.8 },
  boostPad: { durationSec: 1.0, bonus: 0.40, halfLength: 1.5, halfWidth: 2.5 },

  spin: { durationSec: 1.2, decelRate: 4, invulnAfterSec: 1.0, visualTurns: 2 },

  items: {
    dash: { durationSec: 2.0, bonus: 0.50 },
    rocket: { speed: 45, lifeSec: 3, radius: 0.7, ownerGraceSec: 0.5, spawnOffset: 3 },
    homing: { speed: 40, lifeSec: 8, radius: 0.7, ownerGraceSec: 0.5, spawnOffset: 3,
              turnRate: 3.5, directRange: 30, guideAhead: 15 },
    oil: { lifeSec: 15, radius: 1.8, ownerGraceSec: 1.0, dropOffset: 4,
           throwDistance: 18, throwSec: 0.5 },
    shield: { durationSec: 5 },
    // 抽選表(元仕様7.3節を、首位との差で選ぶ形に一般化。2人なら元仕様と同じ)
    tables: {
      leader: { Dash: 15, Rocket: 20, Homing: 0,  Oil: 40, Shield: 25 },
      near:   { Dash: 30, Rocket: 35, Homing: 15, Oil: 10, Shield: 10 },
      far:    { Dash: 35, Rocket: 20, Homing: 40, Oil: 0,  Shield: 5 },
    },
    farGapRatio: 0.25,             // 首位との差がコース1/4周以上なら far
  },

  itemBox: { respawnSec: 5, rouletteSec: 0.8, pickupRadius: 1.8 },

  rubberband: { maxBonus: 0.06, fullGapRatio: 0.25 },   // 0にすれば無効

  wrongWay: { dotThreshold: -0.2, minSpeed: 3, holdSec: 0.8 },

  finished: { maxSpeedMul: 0.6 },  // ゴール後はボットが流す(10.2節)

  autopilot: { lookaheadBase: 12, lookaheadPerSpeed: 0.5, steerGain: 2.0,
               slowAngle: 0.6, speedJitter: 0.05, itemDelayMinSec: 0.5, itemDelayMaxSec: 2.0,
               laneOffsetMax: 4 },           // ボットごとに走るラインを左右にずらす(8台が一列に並ばないように)

  net: { sendHz: 20, progressHz: 10, interpDelayMs: 100, extrapolateMaxMs: 200 },

  test: { effects: false, effectsMinSec: 4, effectsMaxSec: 8, forceItem: null, forceItemBySlot: {} },
};
```

## 5. コース(`core/courseData.js`、`core/course.js`)

### 5.1 データ

```js
export const COURSE_DATA = {
  // 閉じたループ。index の順に走る(上から見て時計回り)。最後の点から最初の点へ戻る。
  waypoints: [
    [-60, 70], [0, 70], [60, 70],                     // 上の直線(スタート/ゴールは index 0)
    [110, 55], [135, 0], [110, -55],                  // 右のカーブ
    [60, -70], [25, -70], [5, -45], [-25, -45], [-45, -70],  // 下の直線に入れたS字
    [-90, -65], [-130, -20], [-125, 30], [-100, 62],  // 左のカーブ
  ],
  roadHalfWidth: 9,       // 道路(|lateral| <= 9)。8台が並べる幅(元の2人用の想定は7)
  wallLateral: 15,        // 9 < |lateral| < 15 は芝、15 に壁
  checkpointCount: 10,    // 元仕様は8〜12個
  grid: {                 // 2列 × 4段。前の段ほどゴールラインから遠い(= 前)
    frontS: 25, rowGap: 6, columnLateral: 3.5, staggerS: 3,
  },
  boostPads: [            // f = 周の割合(0〜1)。s = f * L
    { f: 0.08, lateral: 0 }, { f: 0.28, lateral: -4 }, { f: 0.50, lateral: 4 },
    { f: 0.66, lateral: 0 }, { f: 0.85, lateral: -4 },
  ],
  itemBoxRows: [          // 1列に5個(8人で取り合いになりすぎないように)
    { f: 0.18, laterals: [-6, -3, 0, 3, 6] },
    { f: 0.45, laterals: [-6, -3, 0, 3, 6] },
    { f: 0.75, laterals: [-6, -3, 0, 3, 6] },
  ],
};
```

- 1周はおよそ 650〜750m(平均 22m/s で 30 秒前後。元仕様の「1周25〜40秒」に収まる)。
  実装したら `course.length` をテストで確かめ、外れたらウェイポイントを拡大・縮小して合わせる。
- グリッドはすべてゴールラインの **後ろ(s が 0 より大きい側)** にあるので、スタート直後にゴールラインをまたぐことはない。

### 5.2 `buildCourse(data, cfg)` が返す `Course`

```ts
Course {
  length: number                       // L(m)
  n: number                            // サンプル数
  xs, zs, ss, txs, tzs: Float64Array   // 中心線のサンプル(約1m間隔)。t は単位接線ベクトル
  pointAt(s): { x, z, tx, tz }         // s は L で割った余りに正規化してから使う
  toWorld(s, lateral): { x, z }        // 中心線 + lateral * 左方向ベクトル(左 = (tz, -tx))
  project(x, z, hintIndex?): { s, lateral, index, tx, tz }
  surfaceAt(lateral): 'road' | 'grass' | 'wall'
  checkpoints: Array<{ index, s }>     // index 0 はスタート/ゴールライン(s = 0)。s_k = k * L / N
  boostPads: Array<{ id, s, lateral }>
  itemBoxes: Array<{ id, row, s, lateral }>   // id = row * 5 + col
  gridPose(gridIndex: 0..7): { x, z, yaw }
}
```

- スプラインは **閉じた centripetal Catmull-Rom**(alpha = 0.5)を自前で実装する(`three` は使わない)。
  1区間を細かく(例:50分割)サンプリングしてから、累積距離で **1.0m 間隔に取り直す**。
- `project()`:`hintIndex` があればその前後 ±40 サンプルだけを探し、なければ全体を探す。
  最も近い線分に垂線を下ろして `s` と `lateral` を返す。カートは毎フレーム前回の `index` を渡すこと。
- `lateral` の符号:左方向 `(tz, -tx)` との内積。
- `gridPose(i)`:`row = floor(i / 2)`、`col = i % 2`。
  `s = frontS - row * rowGap - col * staggerS`、`lateral = col == 0 ? +columnLateral : -columnLateral`。
  向きはその点の接線(`yaw = atan2(tx, tz)`)。
- どの slot をどのグリッドに置くかは、ホストが seed からシャッフルして `roundStart.grid` で配る(毎回同じ人が先頭にならないように)。

## 6. カート(`core/kart.js`)

### 6.1 状態

```ts
KartState {
  x, z, yaw, speed          // speed はスカラー(後退はマイナス)。速度の向きは常に yaw(グリップ走行)
  courseIndex               // project() のヒント
  s, lateral, surface       // 直前の投影結果
  spinT                     // スピンの残り時間
  invulnT                   // 被弾しない残り時間(スピン中 + 1.0秒)
  spinVisual                // 見た目の回転角(描画だけに使う)
  boostT, boostBonus        // ブーストの残り時間と上乗せ率
}
createKartState(pose, course): KartState
```

### 6.2 `stepKart(k, input, env, cfg, dt)`

- `input`:`{ throttle: -1..1, steer: -1..1 }`(throttle は W=+1、S=-1)。
- `env`:`{ course, rubberBonus = 0, maxSpeedMul = 1, others: Array<{x, z}> }`
  (`maxSpeedMul` はボットのばらつきとゴール後の減速に使う。`others` はぶつかる相手のカート)。
- 戻り値:`{ wallHit: boolean, kartHit: boolean }`。

手順:

1. **タイマー**:`spinT`、`invulnT`、`boostT` を dt だけ減らす(0 未満にしない)。`boostT` が 0 になったら `boostBonus = 0`。
2. **スピン中**(`spinT > 0`):入力を無視して `throttle = 0, steer = 0` にする。
   `speed *= exp(-spin.decelRate * dt)`。`spinVisual += 2π * visualTurns / durationSec * dt`。
   スピンが終わったら `spinVisual = 0`。
3. **最高速度**:
   `vmax = kart.maxSpeed * maxSpeedMul * (1 + boostBonus + rubberBonus)`。
   直前の `surface` が `grass` なら `vmax *= offroadMaxFactor`。
   加速度は、ブースト中なら `accel * boost.accelMul`。
4. **速度**:
   - `throttle > 0`:`speed < 0` なら `brakeDecel` で 0 に近づける。そうでなければ `speed += accel * throttle * dt`(`vmax` を上限にする)。
   - `throttle < 0`:`speed > 0` なら `brakeDecel * |throttle|` で減速する。そうでなければ `reverseAccel` で `-reverseMaxSpeed` まで後退する。
   - `throttle == 0`:`coastDecel` で 0 に近づける。
   - `speed > vmax` のときは、いきなり切り詰めずに `overSpeedDecel` で `vmax` まで下げる。
5. **旋回**:`|speed| > 0.5` のとき
   `rate = lerp(turnRateLow, turnRateHigh, clamp(|speed| / kart.maxSpeed, 0, 1)) * clamp(|speed| / turnFullSpeed, 0, 1)`、
   `yaw = wrapAngle(yaw - steer * rate * dt * sign(speed))`。
6. **移動**:`x += sin(yaw) * speed * dt`、`z += cos(yaw) * speed * dt`。
7. **投影**:`course.project(x, z, courseIndex)` の結果で `s / lateral / courseIndex / surface` を更新する。
8. **壁**:`|lateral| > wallLateral - radius` なら
   - 位置を `lateral = sign * (wallLateral - radius)` まで押し戻す(`toWorld` を使う)。
   - 速度ベクトル `v = forward * speed` を、接線成分 `vt` と法線成分 `vn` に分けて、`vn = -vn * wallRestitution` にする。
     新しい向きは `v' = vt + vn` の向き(後退中は逆向き)、`speed = sign(speed) * |v'| * wallSpeedKeep`。
   - 大きく減速させない(元仕様4節)。
9. **カートどうし**:`others` の各点との距離が `2 * radius` 未満なら、重なりの **半分** だけ自分を押し離し、`speed *= kartPushSpeedKeep`。
   相手も同じことをするので、合わせてちょうど離れる。何台でも同じ規則で成り立つ。

### 6.3 状態異常

```ts
applySpin(k, cfg): boolean      // invulnT > 0 なら何もしないで false を返す
                                // spinT = durationSec; invulnT = durationSec + invulnAfterSec
applyBoost(k, durationSec, bonus)
                                // boostT = max(boostT, durationSec); boostBonus = max(boostBonus, bonus)
```

- スピンとブーストの適用は **オーナー(そのカートを動かしている端末)が行う**(元仕様5節)。
  ホストからは `applySpin` / `applyBoost` メッセージで指示される。ブーストパッドはオーナーが自分で判定して適用する。
- Shield はホストが管理する(8.5節)。オーナーは表示のためにだけ `shieldState` を受け取る。

## 7. 進行と順位(`core/progress.js`)

### 7.1 オーナー側の周回管理

```ts
Progress { lap, nextCp, prevS, wrongWayT, wrongWay }
createProgress(course, startS): Progress   // lap = 0, nextCp = 1, prevS = startS
updateProgress(p, kart, course, cfg, dt): Array<{ lap, cp }>
```

- `N = checkpointCount`。`nextCp` は 1..N の値をとり、**`nextCp == N` は「次はゴールライン(cp 0)」** を表す。
- チェックポイント k の通過とは、前向きの移動で `s_k` をまたぐこと:
  `prevS < s_k <= s`(k ≥ 1)。cp 0 は `prevS > L - 30 && s < 30`(ラインをまたいで s が一周した)で判定する。
  `s - prevS` の大きさが 30m を超えるとき(投影が飛んだとき)は通過と見なさない。
- `k == nextCp`(1 ≤ k ≤ N-1)のときだけ受け付けて `nextCp++` し、`{ lap, cp: k }` を返す。
- `nextCp == N` で cp 0 を通過したら `lap++`、`nextCp = 1` にして `{ lap: 新しいlap, cp: 0 }` を返す。
  **`lap == cfg.laps` になったらゴール**。
- 順番に通っていないチェックポイントは無視する(ショートカット防止)。
- **逆走**:前方ベクトルと接線の内積が `wrongWay.dotThreshold` 未満、かつ `speed > wrongWay.minSpeed` の状態が
  `holdSec` 続いたら `wrongWay = true`。条件が外れたらすぐ `false` に戻す。
- グリッドは s = 4〜25 の範囲(ゴールラインの直後)で、`lap = 0, nextCp = 1` から始まる(HUD の表示は `LAP 1/2`)。
  グリッドの中に cp 1 はない(cp 1 は s = L/10 ≒ 70m)。

### 7.2 ホスト側の検証と順位

```ts
acceptCheckpoint(hostProg: {lap, nextCp}, lap, cp, N): boolean
  // オーナーの報告が、ホストの持つ状態から見て「次の1つ」なら状態を進めて true
raceDistance(lap, nextCp, s, L, N): number
  // lap * L + s'。ただし nextCp == 1 かつ s > L/2 なら s' = s - L(ゴールラインの手前にいる)
  //                  nextCp == N かつ s < L/2 なら s' = s + L
compareProgress(a, b, L, N): number      // a が前なら正
  // (1) lap、(2) 通過したチェックポイント数 = nextCp - 1、
  // (3) 次のチェックポイントまでの距離(短い方が前)。nextCp == N のときの距離は L - s'
rankPlayers(entries, L, N): number[]     // 順位順の slot の配列
  // entries: [{ slot, lap, nextCp, s, finishedAt | null, left: boolean }]
  // (1) ゴールした人を finishedAt の早い順、(2) 走っている人を compareProgress の順、
  // (3) 抜けた人を最後(抜けた時点の進み具合の順)。完全に同じなら slot の小さい方を前(引き分けにしない)
```

- 順位はホストが決める(元仕様8節)。s はホストから見えている Transform(ホストの中のカートは実際の値、
  リモートのカートは最後に受け取った `kartState`)から投影して求める。
- 首位との差:`gapRatio(slot) = (raceDistance(首位) - raceDistance(slot)) / L`(首位は 0)。

## 8. アイテム(`core/items.js`、`core/projectiles.js`)

### 8.1 抽選

```ts
ITEMS = ['Dash', 'Rocket', 'Homing', 'Oil', 'Shield']
tableFor(rank, gapRatio, cfg)           // rank 1 → leader、gapRatio >= farGapRatio → far、それ以外 → near
rollItem({ rank, gapRatio, rng, cfg, force }): string   // force があればそれを返す
```

- 2人のとき、2位の gapRatio は元仕様の「差」と同じなので、元仕様の3つの表と同じ結果になる。
- 3人以上では、2位以下の全員が「首位との差」で near / far を選ぶ。後ろにいるほど逆転用のアイテムが出やすい。

### 8.2 アイテムボックス(ホストが確定する)

1. オーナーは、自分のカートが `pickupRadius` 以内に入った、**有効に見えている** ボックスについて `requestPickup { boxId }` を送る。
   同じボックスが再出現するまで、同じ boxId は二度送らない。ゴールした人は送らない。
2. ホストは「ボックスが有効」「そのプレイヤーがアイテムを持っていない(ルーレット中も含む)」「ゴールしていない」を確かめ、
   満たせば:ボックスを無効にして `respawnAt = now + respawnSec`、そのときの順位と差で抽選し、
   `itemGranted { slot, item, rouletteMs }` を **全員に** 送る(ほかの人の表示用)。ボックスの状態は `boxState` で送る。
3. 満たさなければ何もしない(拒否メッセージは送らない)。
4. オーナーは `rouletteMs` のあいだ HUD でルーレットを見せ、その後にアイテムを確定表示する。
   ルーレット中は使えない(ホストも `readyAt` で確かめる)。

### 8.3 使う

- オーナーは `requestUseItem { backward }` を送る。
- ホストは所持と `readyAt` を確かめて消費し、`itemCleared { slot }` を送ってから効果を実行する:

| アイテム | ホストの処理 |
|---|---|
| Dash | 使った本人に `applyBoost { slot, durationSec, bonus }` |
| Rocket | 前方(backward なら後方)に `spawnOffset` 離して弾を作る。向きは yaw(backward なら yaw + π) |
| Homing | 前方に作る。`targetSlot` = **使った時点で自分のすぐ前の順位の人**(ゴール済み・抜けた人を除く)。いなければ目標なしでコースに沿って飛ぶ。backward は無視する |
| Oil | 既定では後方 `dropOffset` の位置に置く。`backward` のときは前方 `throwDistance` 先へ投げる |
| Shield | `shieldUntil = now + durationSec * 1000`。`shieldState { slot, active: true }` を全員へ |

- **投げる向きの規則**(元仕様3節「後ろに投げる(アイテムによる)」):
  - `backward` は「そのアイテムの既定と逆に投げる」フラグとして扱う。Rocket は後ろへ、Oil は前へ投げる。Homing / Dash / Shield では無視する。
  - `backward` になるのは、S を押しながら/スティックを下に倒しながら使ったとき、または **後ろを見ている(`lookBack` を押している)間に使ったとき**。
    クライアントは `backward = input.backward || input.lookBack` で送る。両方押しても逆の逆にはしない。
  - オートパイロットもこの規則で使う(元仕様10節)。
- ホストの位置の基準には、ホストから見えているそのカートの最新の Transform を使う。

### 8.4 弾と油(ホストが動かす)

```ts
Projectile { id, type: 'Rocket'|'Homing'|'Oil', owner: slot, x, z, yaw, age, life,
             active: boolean,      // Oil の投擲中は false(当たらない)
             courseIndex, s, targetSlot?: slot }
createProjectile(type, owner, pose, opts, cfg, course): Projectile
stepProjectile(p, ctx: { course, targetPos?: {x, z} }, cfg, dt): 'alive' | 'expired' | 'wall'
isHit(p, kartX, kartZ, cfg): boolean   // p.active かつ 距離 < kart.radius + 弾の radius
```

- **Rocket**:`speed` で yaw 方向にまっすぐ進む。`|lateral| > wallLateral` で `'wall'`、`age >= lifeSec` で `'expired'`。
- **Homing**:毎ステップ目標点を決め、`turnRate` で向きを目標点へ回してから進む。壁を無視する。
  - 目標のカートが `directRange` 以内なら、目標点 = 目標のカートの位置。
  - そうでなければ(目標がいないときも)、目標点 = `course.pointAt(自分の s + guideAhead)`(コースに沿って追いかける)。
  - `age >= lifeSec` で消える。目標がゴールしたり抜けたりしたら、目標なしに切り替える。
- **Oil**:置く場合は `active = true` ですぐ有効。前に投げる場合は `throwSec` かけて `throwDistance` 先の位置まで直線で動かし、着地したら `active = true`。`lifeSec` で消える。
- ホストは `fixedDt` ごとにすべての弾を動かし、消えたものは `despawnObj { id, reason }` を送る。

### 8.5 当たり判定(被弾する側のオーナーが判定)

1. オーナーは毎ステップ、**自分の画面に見えている(補間後の)** 弾・油の位置と自分のカートで `isHit` を調べる。
   当たったら `reportHit { objId }` を送る。同じ objId は二度送らない。自分が `invulnT > 0` のとき、ゴール済みのときは送らない。
2. ホストは次の条件をすべて満たすときだけ確定する:
   - オブジェクトがまだある。
   - 投げた本人に当たった場合は、`age >= ownerGraceSec`(投げた直後の猶予)。
   - そのプレイヤーがホストの記録で被弾できる状態(`invulnUntil <= now`、ゴールしていない)。
   - 同じオブジェクトに複数の報告が来たら、先に処理した1件だけを確定する。
3. 確定したら、オブジェクトを消して `despawnObj { id, reason: 'hit' }` を送り、
   - `shieldUntil > now` なら Shield を消費して `shieldState { slot, active: false }`(スピンさせない)。ログに `shieldBlock`。
   - そうでなければ `applySpin { slot }` を全員に送り、`invulnUntil = now + (spin.durationSec + spin.invulnAfterSec) * 1000` を記録する。
4. Shield は `durationSec` を過ぎたらホストが `shieldState { active: false }` を送る。

### 8.6 ラバーバンド

- ホストは `progress` メッセージで各プレイヤーの順位と `gapRatio` を送る。
- 首位以外のオーナーは `rubberBonus = rubberband.maxBonus * clamp(gapRatio / rubberband.fullGapRatio, 0, 1)` を `stepKart` の env に渡す。首位は 0。
  2人のときは元仕様の「2位だけに補正」と同じになる。

## 9. ネットワーク

### 9.1 構成

```
 ┌──────────────── ホストのブラウザ ─────────────────┐
 │ 枠(frame) ── HostGameNet ──┐                    │
 │                              RaceHost              │ ⇄ PeerJS ⇄ 枠 ─ RaceClient(slot 2)  ゲスト
 │ RaceClient(slot 0, 人)⇄loopback⇄┤               │ ⇄ PeerJS ⇄ 枠 ─ RaceClient(slot 3)  ゲスト
 │ RaceClient(slot 1, bot)⇄loopback⇄┘              │
 └───────────────────────────────────────────────────┘
```

- **ホストの端末でもクライアントを分ける**。ホストのプレイヤーとボットの処理も `RaceClient` が行い、`RaceHost` とはメッセージだけでやりとりする。
  これで、ホスト/ゲスト/ボットのどれでも同じコードが動き、ソロとヘッドレスのテストでもネット対戦と同じ経路を通る。
- `RaceHost` は、リモートのプレイヤーには `HostGameNet`(約束 4節)で、ホストの中のクライアントにはループバック
  (`games/_shared/net/loopback.js` の `createLoopbackPair`)で送る。どちらも同じ `sendTo(slot, msg)` にまとめる。
- ゲストの `RaceClient` は `GuestGameNet` で送る。
- 通信量の目安(8人):ホストは 20Hz で全員分をまとめた `karts`(約 500 バイト)を7人に送る → 約 70KB/s(0.6Mbps)。
  数値は小数第2位までに丸め、キーは短くする。

### 9.2 メッセージ(`game/protocol.js`)

すべて `{ t: 種類, ... }` の JSON。ゲームのインスタンスが違うメッセージは枠が捨てる(約束 4節)ので、ゲーム側でラウンド ID は持たない。
`protocol.js` は種類の定数 `MSG` と、各メッセージを作る関数(例:`msg.kartState(state)`)を持つ。

**クライアント → ホスト**

| t | 中身 | 送る時機 |
|---|---|---|
| `kartState` | `ts, x, z, yaw, speed, spinT, boostT` | `sendHz`。ts はホスト時刻 |
| `reportCheckpoint` | `lap, cp` | チェックポイントの通過ごと |
| `requestPickup` | `boxId` | 8.2節 |
| `requestUseItem` | `backward` | 8.3節 |
| `reportHit` | `objId` | 8.5節 |

**ホスト → クライアント**

| t | 中身 | 送る時機 |
|---|---|---|
| `roundStart` | `startAt, laps, grid: [{ slot, gridIndex }]` | createGame の直後。startAt = now + (startDelaySec + countdownSec) * 1000 |
| `karts` | `ts, list: [{ slot, x, z, yaw, speed, spinT, boostT, finished }]` | `sendHz`。各プレイヤーの最新の状態をまとめて送る(受け取った側は自分の分を無視) |
| `progress` | `elapsedMs, players: [{ slot, lap, nextCp, rank, gapRatio, place }]` | `progressHz`。place はゴールした人の着順(未ゴールは null) |
| `boxState` | `boxId, active` | 変化したとき |
| `itemGranted` | `slot, item, rouletteMs` | 8.2節 |
| `itemCleared` | `slot` | 使ったとき |
| `spawnObj` | `id, type, owner, x, z, yaw, active` | 作ったとき |
| `objState` | `ts, objs: [{ id, x, z, yaw, active }]` | `sendHz`(オブジェクトがなければ送らない) |
| `despawnObj` | `id, reason: 'hit' \| 'expired' \| 'wall'` | 消えたとき |
| `applySpin` | `slot` | 8.5節 |
| `applyBoost` | `slot, durationSec, bonus` | Dash、テスト用の効果 |
| `shieldState` | `slot, active` | 8.3、8.5節 |
| `playerFinished` | `slot, place, timeMs` | 誰かがゴールしたとき |
| `raceEnd` | `reason: 'allFinished' \| 'grace' \| 'first' \| 'timeout', results: [{ slot, place, timeMs \| null, status: 'finished' \| 'racing' \| 'left' }]` | レースが終わったとき(10.1節) |

- 送り先:`applySpin` / `applyBoost` / `shieldState` / `itemGranted` などは全員に送り、受け取った側は `slot` が自分なら適用、そうでなければ演出だけに使う。
- 時刻の同期は枠が行い、ゲームは `ctx.clock.hostNow()` を使う。

### 9.3 カウントダウン

- ホストの `RaceHost` は生成されたらすぐ `roundStart` を送る。`startAt` までに全員の端末でゲームが生成されている前提(`startDelaySec` の余裕)。
- クライアントは `hostNow < startAt` のあいだ入力を止め(元仕様2節の共通入力ゲート)、残り時間から 3,2,1 を表示する。
- 経過時間 = `hostNow - startAt`。

### 9.4 切断(枠からの通知)

- `onDisconnect = 'continue'`(単発版の既定):枠が `game.onPlayerLeft(slot)` を全員の端末で呼ぶ。
  - ホスト:そのプレイヤーを `left` にする(順位は最後。アイテムと Shield は捨てる。そのプレイヤーの弾・油は残す)。
    残っている人が全員ゴールしたら `raceEnd`。
  - クライアント:そのカートを消す。HUD の順位表では「DNF」と表示する。
- `onDisconnect = 'restart'`(BO5Arena):枠がゲームを破棄して作り直すので、ゲームは何もしなくてよい。

### 9.5 相手のカートの補間(`game/interp.js`)

```ts
createSnapshotBuffer({ maxLen = 30, extrapolateMaxMs })
  push(snap: { ts, x, z, yaw, speed, ... })   // ts 順に入る前提。古い ts は捨てる
  sample(renderTs): { x, z, yaw, ... } | null
     // renderTs = hostNow - interpDelayMs。前後のスナップショットを線形補間(yaw は lerpAngle)。
     // 最新より先は、最大 extrapolateMaxMs まで speed と yaw で外挿し、それ以上は止める
```

- ほかのプレイヤーのカート(1台ごとに1つのバッファ)と、弾・油(`objState`。1個ごとに1つ)の両方に使う。
  ホストの中のクライアントも弾・油を `objState` 経由で受け取って補間する(ホストとゲストで見え方をそろえる)。

## 10. 進行の制御

### 10.1 `RaceHost`(`game/host.js`)

```ts
new RaceHost({ cfg, course, seed, roster, now, sendTo(slot, msg), log, onResult })
  handleMessage(slot, msg)
  playerLeft(slot, now)
  update(now, dt)                  // 固定ステップごとに呼ばれる
  get phase(): 'countdown' | 'racing' | 'ended'
  stats                            // 10.4節
```

`update` がすること:弾を動かす → ボックスの再出現 → Shield の期限 → テスト用の効果 → 順位の計算 →
終了の判定 → 決まった頻度で `karts` / `objState` / `progress` を送る。

**ゴールと終了**:

- `acceptCheckpoint` で `lap == laps` になったら、そのプレイヤーの着順を決めて `playerFinished` を送る(同じ update の中では報告を処理した順)。
- 終了の条件(`raceEnd` を送り、`onResult` を呼ぶ):
  - `finishRule = 'first'`:最初の1人がゴールした時点(`reason: 'first'`)。
  - `finishRule = 'grace'`:残っている全員がゴールした時点(`'allFinished'`)、または最初のゴールから `finishGraceSec` 経った時点(`'grace'`)。
  - どちらでも、経過時間が `timeLimitSec` を超えたら `'timeout'`。
  - 全員が抜けてホストの中のプレイヤーだけになっても、レースは続ける(ボットがいれば一緒に走る)。
- 結果は `rankPlayers` で決める。`onResult({ ranking, reason, details: { results } })`。

### 10.2 `RaceClient`(`game/client.js`)

```ts
new RaceClient({ slot, cfg, course, roster, send(msg), controller: 'human' | 'bot', seed, log })
  handleMessage(msg)
  playerLeft(slot)
  update(now, dt, input)           // now はホスト時刻。input は human のときだけ使う
  getView(): RenderView
```

`update` の順序(固定ステップ):

1. 入力ゲートが閉じていれば `throttle = 0, steer = 0`。ゴール済みなら、コントローラーを autopilot に切り替え、
   `maxSpeedMul = finished.maxSpeedMul` で流す(アイテムは使わない、当たり判定をしない、ほかのカートと衝突しない)。
2. `stepKart`(env の `others` には、補間したほかのプレイヤーのカートのうち、ゴールしていない人の位置を入れる)。
3. ブーストパッド:`|s - pad.s| < halfLength` かつ `|lateral - pad.lateral| < halfWidth` で、そのパッドに入った瞬間に `applyBoost`(ログ `boostPad`)。
4. `updateProgress` → 通過ごとに `reportCheckpoint`。
5. アイテムボックスの接触 → `requestPickup`。
6. アイテムの使用(入力のエッジ)→ `requestUseItem`。
7. 弾・油との当たり → `reportHit`。
8. `sendHz` の間隔で `kartState` を送る。

受信したメッセージは `handleMessage` ですぐ状態に反映する(`applySpin` / `applyBoost` の適用、アイテム・Shield・ボックス・弾の表示状態の更新)。

```ts
RenderView {
  phase: 'countdown' | 'racing' | 'finished' | 'ended',
  countdown: number | null,                       // 3,2,1,0(GO)
  lookBack: boolean,                              // 直近の入力の lookBack(bot は常に false)
  self:  { slot, x, z, yaw, spinVisual, boosting, shield, speed, color },
  others: Array<{ slot, x, z, yaw, spinVisual, boosting, shield, finished, color, name }>,
  objects: Array<{ id, type, x, z, yaw, active }>,
  boxes: boolean[],                               // 各ボックスが有効か
  hud: { lap, laps, rank, playerCount, item, rouletteLeft, speedKmh, wrongWay,
         boostLeft, spinLeft, finish: null | { place, timeMs },
         timeLeftSec, graceLeftSec: number | null,
         standings: Array<{ slot, name, color, rank, status: 'racing' | 'finished' | 'left', progress: 0..1 }> },
}
```

- `standings[].progress` はレース全体(`laps * L`)に対する割合。進み具合のバーに使う。

### 10.3 `createGame`(`src/game.js`)

約束 3節の `createGame(ctx)` を実装する。

- `ctx.settings` を `makeConfig` に渡して `cfg` を作る。`buildCourse(COURSE_DATA, cfg)`。
- **ホスト**:`RaceHost` を作る。`roster` のうち `local: true` の人(ホストのプレイヤーとボット)ごとに `RaceClient` を作り、
  ループバックでつなぐ(ボットは `controller: 'bot'`)。リモートの人には `ctx.net` で送る。
- **ゲスト**:自分の `RaceClient` だけを作り、`ctx.net` でホストとつなぐ。
- `update(now)`:前回からの経過時間を `fixedDt` で刻み、ホスト → クライアントの順に `update` を呼ぶ(1回に最大5ステップ)。
  ループバックはステップごとに `pump(now)` する。
- `render(now)`:`dom` があるときだけ、描画するクライアント(自分。`?view=<slot>` があればそのボット)の `getView()` を
  `renderer.render()` と `hud.update()` に渡す。入力は `input.poll()` で取り、次の `update` で使う。
- `dispose()`:renderer、HUD、input を解放する。

### 10.4 ログと統計

- `ctx.log(event, fields)`。出力は `[BO5][MG01] <event> key=value ...`。
- 必ず出すイベント(元仕様11節):`roundStart`, `checkpoint`, `lap`, `finish`(1人ごと), `raceEnd`, `boxPickup`,
  `itemGranted`(rank と gapRatio と table つき), `itemUsed`, `spawn`, `hit`, `shieldBlock`, `spin`, `boostPad`, `boost`, `playerLeft`。
- `RaceHost.stats`:
  `{ grants: { leader: {Dash:0,...}, near: {...}, far: {...} }, uses: {...}, hits: n, shieldBlocks: n }`。
  ブラウザでは `window.__mg01 = { host, clients, stats }` に出す(検証用)。

### 10.5 オートパイロット(`core/autopilot.js`)

```ts
createAutopilot(rng, cfg): Bot
  // speedMul = 1 + rng.range(-speedJitter, +speedJitter)
  // laneOffset = rng.range(-laneOffsetMax, +laneOffsetMax)(走るラインを左右にずらす)
botInput(bot, kart, course, ctx: { heldItem, itemReady, targetAhead: boolean, targetBehind: boolean }, dt)
  : { throttle, steer, useItem, backward }
```

- 目標点 = `course.toWorld(kart.s + lookaheadBase + lookaheadPerSpeed * |speed|, bot.laneOffset)`。
  向きとの差 `angle = wrapAngle(atan2(dx, dz) - yaw)`、`steer = clamp(-angle * steerGain, -1, 1)`(右がプラスなので符号が逆になる)。
- `throttle = |angle| > slowAngle ? 0.5 : 1`。
- アイテムを持ってルーレットが終わったら、`rng.range(itemDelayMinSec, itemDelayMaxSec)` 秒後に使う。
  Oil は既定(後ろ)、Rocket はすぐ前に人がいれば前、いなくてすぐ後ろに人がいれば `backward = true`(元仕様10節)。
- `RaceClient` は bot のとき `stepKart` の env に `maxSpeedMul = bot.speedMul` を渡す。

### 10.6 入力(`game/input.js`、ブラウザ専用)

```ts
createInput(targetElement) → { poll(): { throttle, steer, useItem, backward, lookBack }, dispose() }
```

| 操作 | キーボード/マウス | ゲームパッド(標準マッピング) |
|---|---|---|
| throttle +1 | W / ↑ | RT(buttons[7].value) |
| throttle -1 | S / ↓ | LT(buttons[6].value) |
| steer | A / ← = -1、D / → = +1 | 左スティック axes[0](不感帯 0.15) |
| useItem(押した瞬間だけ true) | Space / 左クリック | A(buttons[0]) |
| backward | S を押している | axes[1] > 0.5 |
| lookBack(押している間だけ) | C | X(buttons[2]) |

- throttle は `W - S`(両方押したら 0)。ゲームパッドとキーボードは大きい方を使う。
- ページのスクロールを防ぐため、矢印キーと Space の既定動作を止める。
- `lookBack` は **押している間だけ** true(トグルにしない)。ウィンドウがフォーカスを失ったり、タブが裏に回ったりしたら、押しているキーをすべて離した扱いにする。
- 後ろを見ていても、運転の操作(throttle / steer)はそのまま効く。

## 11. URL パラメータ

共通のもの(`?room=`、`?name=`、`?solo=1`、`?bots=N`、`?debug=1`)は約束 9節。ゲーム固有のものは `settings` としてゲームに渡る。

| パラメータ | 意味(元仕様の起動引数) |
|---|---|
| `?laps=1` | 周回数を上書き |
| `?finishRule=first` | 1位が決まった時点で終える(BO5Arena と同じ挙動を試す) |
| `?autopilot=1` | 自分のカートもオートパイロットにする(`-bo5-autopilot`) |
| `?view=<slot>` | ホストの中のボットの視点で描画する(デバッグ用) |
| `?latency=120` | ホストの中のボットとのループバックに遅延をかける(ms。遅延への強さを確かめる) |
| `?testEffects=1` | スピンやブーストをランダムに起こす(`-bo5-mg01-test-effects`)。ホストが適用 |
| `?forceItem=Rocket` / `?forceItem<slot>=Rocket` | 抽選をやめて指定のアイテムを渡す(`-bo5-mg01-force-item`。ホストで指定。例:`?forceItem1=Homing`) |

## 12. 描画(`render/`、ブラウザ専用)

```ts
createRenderer(canvas, course, cfg, roster) → { render(view: RenderView, dt), resize(), dispose() }
```

- `WebGLRenderer({ antialias: true })`、`setPixelRatio(min(devicePixelRatio, 2))`。影は使わない。
- 光:`HemisphereLight`(空 0xbfd9ff / 地面 0x4a7a3a)+ `DirectionalLight`。背景と霧は空色(`Fog` 150〜400m)。
- **コース**(`courseMesh.js`):サンプルごとに `toWorld(s, ±lateral)` で左右の点を作り、`BufferGeometry` の三角形の帯にする。
  - 芝:コース全体を覆う大きな平面(y = -0.02、緑 0x3f8f3a)。
  - 道路:`±roadHalfWidth` の帯(y = 0、灰色 0x555a60)。縁石として道路の端に幅0.6mの赤白の帯。
  - 壁:`±wallLateral` に高さ 1.2m の縦の帯(両面、0xd8d8d8)。
  - スタート/ゴールライン:s = 0 に市松模様のテクスチャ(CanvasTexture)。グリッドの白線(8か所)。
  - ブーストパッド:オレンジの板(5m × 3m、y = 0.02)に矢印のテクスチャ。
  - アイテムボックス:1m の半透明の立方体(虹色系)に「?」の CanvasTexture。回転と上下の揺れ。無効な間は非表示。
- **カート**(`kartMesh.js`):車体 Box(1.6 × 0.6 × 2.4)+ 座席の小さな Box + 車輪 Cylinder × 4。色は `cfg.colors[slot]`。
  スピン中は車体の Group を `spinVisual` だけ回す。ブースト中は後ろに炎の円錐、Shield 中は半透明の球。
  頭上に名前(Sprite。自分のカートには出さない)。ゴール済みのカートは半透明にする(ぶつからないことを示す)。抜けた人のカートは消す。
- **弾・油**(`objects.js`):id をキーにメッシュを使い回す。Rocket = 細長い円錐(オレンジ)、Homing = 紫の球と光る輪、
  Oil = 黒い平たい円(`active` でないあいだは少し浮かせて表示)。
- **カメラ**(`camera.js`):`PerspectiveCamera(70)`。
  - 通常:目標位置 = カートの後方 7m、上 3.2m。`pos += (target - pos) * (1 - exp(-8 * dt))`。注視点 = カートの前方 4m。
    ブースト中は FOV を 80 まで上げる。カメラは `spinVisual` の回転に追従させない(酔わないように)。
  - **後方視点**(`view.lookBack` が true の間だけ):カメラをカートの前方 6m・上 3m に置き、カートの後方 10m を見る。
    押したときも離したときも補間せずに一瞬で切り替える(一瞬だけ確認したいので)。離したら通常の追いかけ位置から再開する。

## 13. HUD(`ui/hud.js`)

キャンバスの上に重ねる HTML。ロビーと結果画面は枠(standalone)が出す。

- 左上:`LAP 1/2`、順位 `3rd / 7`、残り時間。1位のゴール後(`grace`)は「あと 12 秒で終了」。
- 左:**順位表**(順位、色、名前。ゴールした人は ✓、抜けた人は DNF)。8人でも見切れない大きさ。
- 右上:アイテムの枠(ルーレット中はアイテム名のアイコンを 60ms ごとに切り替える)。後ろを見ている間は、投げる向きが逆になることを示す「↩」を添える。
- 下:速度(km/h)、進み具合のバー(全員を色つきのマーカーで表示し、自分のマーカーを大きくする)。
- 中央:カウントダウン(3, 2, 1, GO!)、`WRONG WAY`(赤く点滅)、`BOOST!` / `SPIN!` の一時表示、ゴールしたら `FINISH! 2nd`。
- 上中央:後ろを見ている間だけ `REAR VIEW`(小さく)。
- 文言:HUD の短い表示は元仕様どおり英語。
- 操作説明(standalone のタイトル画面に渡す):W/S/A/D、Space(アイテム)、S+Space(逆向きに投げる)、
  C / X(後ろを見る。押している間。この間に使うと逆向きに投げる)。

## 14. 検証(元仕様11節の対応)

| 元仕様の観点 | Web版での確かめ方 |
|---|---|
| 2周して勝敗が決まる。両陣営とも勝つことがある | `tests/sim.test.js`:ボット2台で 30 レース → すべて終了し、両方が1回以上勝つ。ボット8台で 10 レース → すべて終了し、1位の slot が3種類以上ある |
| アイテムの取得・使用・命中・Shield の防御がログに出る | 同テストでログを集め、それぞれのイベントが1回以上あることを確かめる(`forceItem` を使ったレースも含める) |
| ブーストパッドの効果がログに出る | 同上(`boostPad`) |
| 2位の方が Homing / Dash が出やすい | 2台のレースの `stats.grants` を集計し、2位(near + far)の Homing + Dash の割合が1位より高いこと。`items.test.js` で表どおりの分布になることも確かめる |
| 再接続でやり直したときに、カート・弾・油の残骸が出ない | 枠のテスト(`_shared/tests/frame.test.js`):`onDisconnect = 'restart'` で切断 → 再接続 → 新しいゲームのインスタンスに前のインスタンスのメッセージが届かないこと。Race の `sim.test.js`:新しく作ったゲームの `objects` が空 |
| (Web版で追加)途中で抜けても続く | `sim.test.js`:8台のレースの途中で1台を `playerLeft` → レースが最後まで進み、その人が最下位(left)になる |
| (Web版で追加)`finishRule` | `'first'` で1位のゴール時に終わる。`'grace'` で1位のゴールから15秒以内に終わる |
| (Web版で追加)遅延に耐える | `?latency=150` でボットと遊び、弾が当たったときの見た目と判定が大きくずれないこと |

## 15. 今後調整する項目

元仕様12節と同じ(速度・加速・ハンドリング、周回数、出現率、ラバーバンド、コースの形、アート、サウンド)に加えて、
8人のときの道幅・ボックスの数・`finishGraceSec`。すべて `RaceConfig` と `COURSE_DATA` の値の変更だけで調整できるようにしておく。
