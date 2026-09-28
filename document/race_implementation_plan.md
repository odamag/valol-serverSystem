# MG01 Race Web版 実装プラン(サブエージェント用)

設計は次の2つ。
- `document/minigame_contract.md`(以下「約束」):全ゲーム共通の枠 `games/_shared/`
- `document/race_design.md`(以下「設計書」):レースの本体 `games/race/`

この文書は、それをサブエージェント(Sonnet)に分けて実装させるための、タスクの分け方・順序・完了条件・依頼文をまとめたもの。
パスは、特に書いていなければ `games/race/` からの相対パス。

## 1. 進め方(オーケストレーター向け)

- オーケストレーター(親のセッション)が、下の **ウェーブ** の順にタスクをサブエージェントへ依頼する。
  同じウェーブのタスクは **触るファイルが重ならない** ので、同じ作業ツリーで並行して動かしてよい。
- 依頼には Agent ツールを使う:`subagent_type: "general-purpose"`、`model: "sonnet"`。依頼文は 4節のテンプレートに、3節のタスクの内容を入れて作る。
- 各ウェーブが終わったら、オーケストレーターが次のことをしてからコミットする:
  1. `cd games/_shared && npm test` と `cd games/race && npm test`(すべて通ること。まだテストがない方は飛ばす)
  2. 各タスクの「触ってよいファイル」以外が変わっていないかを `git status` で確かめる
  3. サブエージェントの報告に「設計書との食い違い」があれば、**先に設計書・約束を直して** から次のウェーブへ進む
- サブエージェントには、コミットさせない・設計書と約束を書き換えさせない(報告だけさせる)。
- 失敗したタスクは、エラー出力と報告を添えて同じタスクをもう一度依頼する(`SendMessage` で続けてもよい)。

### 依存関係

```
W0  T0 土台(_shared と race の雛形、rng、math、config、プロトコル)
      │
W1  T1 コース   T2 通信の部品(loopback, channel, clock)   T3 アイテム抽選   T4 補間
      │                     │
W2  T5 カートと周回   T6 弾とオートパイロット   T7 描画   T8 枠(hostFrame / guestFrame / roster)
      │                  │                        │           │
W3  T9 RaceHost      T10 RaceClient                │           │
      └──────┬──────────┘                          │           │
W4        T11 createGame とヘッドレス結合テスト ───────────────┘
             │                                     │
W5        T12 単発版の画面(standalone、PeerJS、ticker)と HUD・入力
             │
W6        T13 組み込みと仕上げ
```

## 2. 全タスク共通のルール(依頼文に必ず入れる)

1. 約束と設計書の、タスクに書いた節を読んでから書き始める。設計書の **2節(共通の規約)** は必ず読む。
2. ファイル名・export 名・関数の引数と戻り値・メッセージ名・座標系は、約束と設計書のとおりにする。
   決められないこと、そのとおりだと動かないことがあれば、**勝手に変えずに** 報告に書く(小さな補助関数を足すのはよい)。
3. 「触ってよいファイル」以外は作らない・変えない。
4. ロジックのファイル(約束 10節と設計書 2.2節でブラウザ専用とされていないもの)では、
   DOM、`window`、`three`、`Peer`、`Date.now`、`performance.now`、`setTimeout`、`setInterval`、`Math.random` を使わない。
5. npm パッケージは追加しない。テストは `node:test` と `node:assert/strict` だけで書く。
6. コメントは日本語で、何をしているかより「なぜそうしているか」を短く書く。JSDoc で引数と戻り値の型を書く。
7. 完了条件のコマンドを実行し、結果(通ったテストの数、失敗があればその出力)を報告する。
8. 最後に、作った/変えたファイルの一覧、設計書からの食い違いや判断したこと、気になった点を報告する。

## 3. タスク

### T0 土台(W0)

- **読む節**:約束 1、2、10、11。設計書 1〜4、9.2
- **触ってよいファイル**:
  `games/_shared/package.json`、`games/_shared/core/rng.js`、`games/_shared/frame/protocol.js`、`games/_shared/tests/rng.test.js`、
  `games/race/package.json`、`games/race/index.html`、`games/race/style.css`、`src/config.js`、`src/core/math.js`、
  `src/game/protocol.js`、`tests/math.test.js`、`tests/protocol.test.js`、`.claude/launch.json`
- **内容**:
  - 2つの `package.json`(約束 11節、設計書 3節)。
  - `rng.js`:mulberry32 による `createRng(seed)`。`shuffle` は元の配列を変えずに新しい配列を返す。`fork()` は `next()` の値から子の seed を作る。
  - `_shared/frame/protocol.js`:`FRAME_VERSION = 1` と約束 8節のメッセージの作成関数。
  - `race/src/game/protocol.js`:`MSG`(設計書 9.2節のすべての t)と作成関数 `msg.<名前>(...)`。
  - `config.js`:設計書4節の `RaceConfig` と `makeConfig(overrides)`。
  - `math.js`:`clamp, lerp, wrapAngle, lerpAngle, forwardVec, leftVec, dist2`。
  - `index.html`:importmap(`three` → `https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js`)、
    PeerJS(`https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js`)、全画面の `<canvas id="game">`、`<div id="hud">`、`<div id="lobby">`。
    `<script type="module">` で `../_shared/standalone/standalone.js` の `startStandalone` と `./src/game.js` の `definition` を読み、
    `startStandalone(definition, ...)` を呼ぶ(これらのファイルは後のタスクで作るので、T0 の時点では動かなくてよい)。
  - `.claude/launch.json`:既存のファイルがあれば設定を足す。なければ作る。
    `{"name": "race", "runtimeExecutable": "npx", "runtimeArgs": ["--yes", "http-server", ".", "-p", "5174", "-c-1"], "port": 5174}`
    (リポジトリのルートを配信し、`http://localhost:5174/games/race/` で開く)。
- **完了条件**:両方の `npm test` が通る。`wrapAngle`、`forwardVec(0) = (0, 1)`、`leftVec(0) = (1, 0)`、
  同じ seed の rng が同じ列を返すこと、`shuffle` が並べ替えだけをすること、`msg.*` がすべて正しい `t` を持つこと、
  `makeConfig` が元の `RaceConfig` を変えないことをテストする。

### T1 コース(W1)

- **読む節**:設計書 2、5
- **触ってよいファイル**:`src/core/courseData.js`、`src/core/course.js`、`tests/course.test.js`
- **完了条件**(テストに入れる):
  - `course.length` が 600〜800m。外れたらウェイポイントを一様に拡大・縮小して収める(報告に倍率を書く)。
  - いろいろな s で `project(pointAt(s))` の s が元の s と 0.5m 以内(ゴールラインをまたぐ所も含む)、lateral が 0 に近い。
  - `toWorld(s, 5)` を `project` すると lateral ≈ +5。左がプラスであること(`leftVec` と向きが合う)。
  - チェックポイントが10個で、`checkpoints[0].s === 0`、等間隔。
  - `gridPose(0..7)` の8か所が互いに 3m 以上離れていて、すべて道路の上、s が 0 より大きく cp 1 より手前。
  - 中心線の曲率半径の最小値が、道路の半幅(9m)より大きい(カーブの内側で道路が裏返らないこと)。
  - `hintIndex` つきの `project` を中心線に沿って1周ぶん続けて呼び、s が単調に進む(ゴールで一周する所を除く)。
  - アイテムボックスが 15 個、`id = row * 5 + col`。

### T2 通信の部品(W1)

- **読む節**:約束 4、8、11
- **触ってよいファイル**:`games/_shared/net/transport.js`、`games/_shared/net/loopback.js`、`games/_shared/net/channel.js`、
  `games/_shared/frame/clock.js`、`games/_shared/tests/loopback.test.js`、`games/_shared/tests/channel.test.js`、`games/_shared/tests/clock.test.js`
- **完了条件**:
  - loopback:`pump(now)` を呼ぶまで届かない、`latencyMs` どおりに届く、順番が変わらない、`close()` で相手の `onClose` が呼ばれる、
    関数を含むメッセージを送るとエラーになる。
  - channel:`frame` と `game` のメッセージが混ざらずに届き、`game` のメッセージに `gi` がつく。
  - clock:遅延 100ms・オフセット +5000ms の擬似環境で、5回の ping/pong の後の `hostNow` の誤差が 10ms 以内。

### T3 アイテムの抽選(W1)

- **読む節**:設計書 2、8.1
- **触ってよいファイル**:`src/core/items.js`、`tests/items.test.js`
- **完了条件**:
  - 3つの表それぞれで 20,000 回抽選し、各アイテムの割合が表の値 ±1.5 ポイント以内。
  - 1位(leader)では Homing が出ない、far では Oil が出ない。
  - `force` を渡すと必ずそれが返る。
  - `gapRatio` が `farGapRatio` ちょうどのときは far。rank 2 以上で gapRatio が小さいときは near。

### T4 補間(W1)

- **読む節**:設計書 2、9.5
- **触ってよいファイル**:`src/game/interp.js`、`tests/interp.test.js`
- **完了条件**:2つのスナップショットの中間を正しく補間する、yaw が π をまたいでも近い向きに補間する、
  `extrapolateMaxMs` を超えて外挿しない、古い ts のスナップショットは捨てる。

### T5 カートと周回(W2、T1 の後)

- **読む節**:設計書 2、5.2、6、7
- **触ってよいファイル**:`src/core/kart.js`、`src/core/progress.js`、`tests/kart.test.js`、`tests/progress.test.js`
- **完了条件**:
  - 道路の直線でアクセルを入れ続けると、2秒以内に最高速度の 90% に達し、最高速度を超えない。
  - 芝では最高速度の 50%(± 0.5m/s)に落ち着く。
  - `steer = +1`(右)で yaw が減る。前進中に右に曲がると、進路の右側(lateral がマイナス側)へずれる。
  - 壁に斜めに突っ込み続けても |lateral| が `wallLateral` を超えず、速度が 0 にならない。
  - スピン中は入力が効かず、減速し、1.2秒後に元に戻る。スピン中と終了後1秒は `applySpin` が false を返す。
  - ブーストで最高速度が +40% になり、時間が切れると戻る。重ねがけでは長い方の時間・大きい方の率になる。
  - 3台を同じ場所に置いて `others` を与えて何ステップか動かすと、互いに `2 * radius` 以上離れる。
  - 中心線をなぞる擬似走行で、10個のチェックポイントが順に報告され、2周で `lap == 2` になる。
  - 1つ飛ばすと周回にならない。ゴールラインを後ろ向きにまたいでも周回にならない。逆向きに走ると `wrongWay` になる。
  - `raceDistance` がゴールラインの前後で連続している。`compareProgress` が「周回 → チェックポイント → 距離」の順で比べる。
  - `rankPlayers`:ゴールした人(着順)→ 走っている人 → 抜けた人の順。完全に同じなら slot の小さい方が前。

### T6 弾とオートパイロット(W2、T1 の後)

- **読む節**:設計書 2、8.3〜8.5、10.5
- **触ってよいファイル**:`src/core/projectiles.js`、`src/core/autopilot.js`、`tests/projectiles.test.js`、`tests/autopilot.test.js`
- **補足**:autopilot のテストは T5 の `stepKart` がまだないので、テスト内で「yaw 方向に速度 20m/s で進むだけ」の簡単なカートを使う。
  T5 と組み合わせた確認は T11 で行う。
- **完了条件**:
  - Rocket が直線で進み、壁に届くと `'wall'`、3秒で `'expired'` になる。後方に撃つと逆向きに進む。
  - Homing が 30m 以上先の目標をコースに沿って追いかけ、8秒以内に `isHit` になる(目標は中心線上を 20m/s で走る)。
    目標なしのときはコースに沿って飛び、8秒で消える。
  - Oil を前に投げると `throwSec` のあいだは `active = false` で、`throwDistance` 先で止まって有効になる。15秒で消える。
  - autopilot:簡単なカートを `botInput` で動かすと、壁(|lateral| > 15)に触れずにコースを1周できる(laneOffset が最大のときも)。
    `speedMul` が 0.95〜1.05 に収まる。アイテムを使うタイミングが 0.5〜2 秒の範囲。

### T7 描画(W2、T1 の後)

- **読む節**:設計書 2.1、5.2、10.2 の `RenderView`、12
- **触ってよいファイル**:`src/render/*.js`、`dev/render-preview.html`、`dev/render-preview.js`
- **内容**:`dev/render-preview.html` は、ゲームのロジックなしで描画だけを確かめるページ。
  `buildCourse` でコースを作り、自分のカートを中心線に沿って 20m/s で走らせ、ほかの7台をその後ろに並べ(1台はゴール済みで半透明)、
  ダミーの弾(Rocket、Homing、Oil)を並べた `RenderView` を毎フレーム作って `render()` に渡す。
  キー 1 でスピン、2 でブースト、3 で Shield の見た目を切り替える。C を押している間は `view.lookBack = true` にする。
- **完了条件**:
  - `.claude/launch.json` の `race` でサーバーを立て、`http://localhost:5174/games/race/dev/render-preview.html` を開く。
    コンソールにエラーがないこと、道路・芝・壁・スタートライン・グリッド・パッド・ボックス・8台のカート(8色と名前)・弾が見えることを、スクリーンショットで確かめて報告する。
  - ウィンドウの大きさを変えても表示が崩れない。
  - C を押している間だけ後方視点になり、後ろのカートが見える。離すと一瞬で通常の視点に戻る。
  - (ブラウザを使えない環境なら、そのことを報告する。`node --check` で全ファイルの構文だけは確かめる)

### T8 枠(W2、T2 の後)

- **読む節**:約束 すべて
- **触ってよいファイル**:`games/_shared/frame/roster.js`、`games/_shared/frame/hostFrame.js`、`games/_shared/frame/guestFrame.js`、
  `games/_shared/tests/frame.test.js`、`games/_shared/tests/fakeGame.js`
- **補足**:テストでは、約束 2・3節の形をした小さな偽のゲーム(`fakeGame.js`:ホストが一定時間後に `onResult` を呼ぶだけ、
  受け取ったメッセージを記録するだけ)を使う。ホストの枠とゲストの枠を loopback でつなぎ、`now` を自分で進める。
- **完了条件**:
  - `hello` → `welcome`、名簿が全員に配られる。`maxPlayers` を超えたら `reject: 'full'`、バージョン違いは `reject: 'version'`。
  - ボットを足すと名簿に `kind: 'bot', local: true`(ホストで)として入り、人数の上限に数えられる。
  - `startGame` で全員の端末で `createGame` が同じ seed・同じ名簿で呼ばれ、`onResult` の後に `endGame` が全員に届き、`dispose` が呼ばれる。
  - 同じ `playerId` で再接続すると同じ slot に戻る。
  - `onDisconnect = 'continue'`:ゲーム中の切断で、残った全員の `onPlayerLeft(slot)` が呼ばれ、ゲームは続く。戻ってきた人は `waiting` になり、次のゲームから名簿に入る。
  - `onDisconnect = 'restart'`:ゲーム中の切断でゲームが破棄されて `paused` になり、戻ると新しい `gi` と seed で作り直される。
    **前のインスタンスあてのゲームのメッセージは、新しいインスタンスに届かない。**
  - ゲスト側の時刻同期が効いている(ゲームの `ctx.clock.hostNow()` がホストの時刻と 10ms 以内)。

### T9 RaceHost(W3、W1〜W2 の後)

- **読む節**:設計書 2、7.2、8、9、10.1、10.4
- **触ってよいファイル**:`src/game/host.js`、`tests/host.test.js`
- **補足**:テストでは `sendTo` を記録用の関数にして、クライアントのふりをしたメッセージを `handleMessage` に渡す。
- **完了条件**:
  - 生成直後に `roundStart` が全員に送られ、`startAt` と、seed からシャッフルした `grid` が入っている。
  - 順番どおりの `reportCheckpoint` だけを受け付け、2周で `playerFinished`。飛ばした報告は無視する。
  - `finishRule = 'first'` では最初のゴールで `raceEnd` と `onResult`。`'grace'` では全員がゴールした時点か、最初のゴールから15秒で終わる。
  - 制限時間を過ぎると `'timeout'` で、進み具合の順の `ranking` になる。
  - `requestPickup`:有効なボックスで `itemGranted` と `boxState(false)`、5秒後に `boxState(true)`。所持中・ゴール済みは無視。
    抽選の表が順位と首位との差で選ばれる(ログの `table`)。
  - `requestUseItem`:ルーレット中は無視。Rocket で `spawnObj`、Dash で `applyBoost`、Shield で `shieldState`。
    Homing の `targetSlot` がすぐ前の順位の人になる。
  - `reportHit`:猶予中の自爆は無視、確定したら `despawnObj` と `applySpin`。Shield 中は `shieldBlock` で消費だけする。無敵中は無視。同じ弾への2件目は無視。
  - `playerLeft`:その人が `ranking` の最後になり、残りの人でレースが終わる。
  - `forceItemBySlot` で指定の人に必ず指定のアイテムが出る。`stats.grants` が数えられている。

### T10 RaceClient(W3、W1〜W2 の後。T9 と並行)

- **読む節**:設計書 2、6.3、7.1、8.2〜8.6、9、10.2、10.5
- **触ってよいファイル**:`src/game/client.js`、`tests/client.test.js`
- **補足**:テストでは `send` を記録用の関数にして、ホストのふりをしたメッセージを `handleMessage` に渡す。
- **完了条件**:
  - `startAt` 前は入力しても動かず、`getView().countdown` が 3 → 2 → 1 と減る。startAt 後は動く。
  - `roundStart.grid` の自分の位置から始まる。
  - `kartState` が `sendHz` の間隔で送られ、`ts` がホスト時刻になっている。
  - チェックポイントを通ると `reportCheckpoint` が送られる。
  - パッドを踏むと自分で `applyBoost` し、ログに `boostPad` が出る。
  - ボックスに触れると `requestPickup` が1回だけ送られる。`itemGranted` の後、`rouletteMs` が過ぎるまで使えない。
  - `objState` で受け取った弾に当たると `reportHit` が1回だけ送られる。自分あての `applySpin` でスピンし、ほかの人あてでは何も起きない。
  - `karts` で受け取ったほかの7台が `getView().others` に補間されて出る。`playerLeft` でその人が消える。
  - ゴール後は autopilot で流れ、アイテムを使わず、当たりを報告しない。
  - `lookBack: true` の入力でアイテムを使うと `requestUseItem { backward: true }` が送られ、`getView().lookBack` が true になる。
  - `controller: 'bot'` のとき入力なしで走り、アイテムを使う。

### T11 createGame とヘッドレス結合テスト(W4、T8〜T10 の後)

- **読む節**:約束 2〜5、10、11。設計書 10.3、14
- **触ってよいファイル**:`src/game.js`、`tests/sim.test.js`。
  **結合して見つかった不具合は `src/core/*`、`src/game/host.js`、`src/game/client.js` を直してよい**(直した箇所を報告する)。
  枠の不具合は直さずに報告する。
- **内容**:`sim.test.js` は、約束 11節の `createHostFrame` / `createGuestFrame` と loopback を使い、
  `now` を自分で進めてレースを回す(実時間はかからない)。ボットはホストの枠の `addBot` で足す。
- **完了条件**:
  - ボット2台(ホストの人も autopilot)で 30 レース(seed を変える)→ すべて `timeLimitSec` 以内に終わり、両方が1回以上勝つ。
  - ボット8台で 10 レース → すべて終わり、1位の slot が3種類以上ある。
  - ログに `itemGranted`、`itemUsed`、`hit`、`boostPad`、`lap`、`finish`、`raceEnd` が出る。
    `forceItemBySlot` で Shield と Rocket を渡したレースで `shieldBlock` が出る。
  - 2台のレースの `stats` を集計し、2位の(Homing + Dash)の割合 > 1位の割合。
  - ゲストの枠1つ(ボットのクライアントで操作)+ ホストの枠で、ループバックを 150ms にしても上の条件(2台)が成り立つ。
  - 8台のレースの途中でゲストを1人切断(`onDisconnect = 'continue'`)→ 最後まで進み、その人が最下位になる。
  - `finishRule = 'first'` で、最初のゴールで終わる。
  - もう一度(新しいゲーム)を始めた直後、全クライアントの `getView().objects` が空。
  - 30レースの1周の平均タイムを報告する(元仕様の目安 25〜40 秒に入っているか)。

### T12 単発版の画面と HUD・入力(W5、T7・T11 の後)

- **読む節**:約束 6、7、9、11。設計書 10.3、10.6、11、12、13
- **触ってよいファイル**:`games/_shared/net/peer.js`、`games/_shared/frame/ticker.js`、`games/_shared/frame/ticker.worker.js`、
  `games/_shared/standalone/*`、`src/game/input.js`、`src/ui/hud.js`、`src/game.js`(描画と入力をつなぐ部分)、
  `games/race/index.html`、`games/race/style.css`
- **完了条件**(ブラウザで確かめ、スクリーンショットを報告に添える):
  - `?solo=1&bots=7` でカウントダウン → 8台のレース → 結果画面(順位表)→ 「もう一度」まで通る。コンソールにエラーがない。
  - キーボードで走り、Space でアイテムを使える。`?forceItem0=Rocket` で前後に撃ち分けられる。
  - C を押している間だけ後方視点と `REAR VIEW` が出る。その間に Space を押すと Rocket が後ろへ飛ぶ。C を離すと前に戻る。
  - 順位表、進み具合のバー、`grace` の残り秒数が表示される。
  - 同じブラウザの2つのタブで同じ合言葉を入れると、ホストとゲストとしてロビーに入り、ホストがボットを足してスタートできる。
  - ホストのタブを裏に回して 10 秒待っても、ゲストのタブでレース(ほかのカートと弾)が止まらない。
  - ゲストのタブを閉じるとホストのレースは続き、そのゲストは DNF になる。同じ合言葉で入り直すと観戦待ちになり、次のレースから参加できる。

### T13 組み込みと仕上げ(W6)

- **触ってよいファイル**:`frontend/src/pages/MiniGames.jsx`、`.github/workflows/deploy.yml`、`.github/workflows/ci.yml`、
  `document/race_design.md` と `document/minigame_contract.md`(実装に合わせた小さな修正だけ)
- **内容**:
  - `MiniGames.jsx` の `games` に `{ href: '/games/race/', icon: '🏎️', title: 'アイテムレース', description: 'アイテムとブーストで最後まで逆転できるカートレース。最大8人でP2P対戦、ボットとの練習も。', tag: '2〜8プレイヤー' }` を足す。
  - `deploy.yml` の lftp の除外に `games/*/tests/`、`games/*/dev/`、`games/*/package.json` を足す。
  - `ci.yml` に、Node 20 で `games/_shared` と `games/race` の `npm test` を実行するジョブ(`games-test`)を足す。
  - 実装で決めた値(コースの倍率、調整した数値)を設計書に反映する。
- **完了条件**:`cd frontend && npm run build` が通る。2つの `npm test` が通る。

## 4. 依頼文のテンプレート

```
あなたは MG01 Race Web版の実装タスク「{タスクID} {タスク名}」を担当します。
リポジトリのルートは {作業ツリーの絶対パス} です。

まず次のものを読んでください。
- document/minigame_contract.md(約束)の {約束の読む節}
- document/race_design.md(設計書)の 2節と {設計書の読む節}
- document/race_implementation_plan.md の 2節(共通のルール)と 3節の {タスクID}

このタスクで触ってよいファイル:
{触ってよいファイル}

すでにあるファイル(読むだけ。変えない):
{前のウェーブまでにできたファイル}

やること:
{内容と完了条件を、plan からそのまま貼る}

終わったら、次の形で報告してください。
1. 作った/変えたファイル
2. 完了条件ごとの結果(実行したコマンドと、その出力の要点)
3. 設計書・約束と食い違った点、書かれていなかったので自分で決めた点
4. 次のタスクの担当者が知っておくべきこと
コミットはしないでください。設計書と約束も書き換えないでください。
```

## 5. 規模の目安

| ウェーブ | タスク | 目安 |
|---|---|---|
| W0 | T0 | 小 |
| W1 | T1, T2, T3, T4(並行) | 小〜中 |
| W2 | T5, T6, T7, T8(並行) | 中 |
| W3 | T9, T10(並行) | 中〜大 |
| W4 | T11 | 中(結合の不具合直しを含む) |
| W5 | T12 | 大 |
| W6 | T13 | 小 |

W3〜W5 が山場。T11 のヘッドレステストが通れば、ネットワークの経路はソロとネット対戦で共通なので、
残るのは PeerJS の接続と画面まわりだけになる。枠(T8、T12 の standalone)は次のゲームでもそのまま使える。
