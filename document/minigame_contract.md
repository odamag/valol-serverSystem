# ミニゲームの共通の約束(Web版)

## 0. この文書について

- ブラウザで遊ぶ対戦ミニゲーム(`games/<id>/`)を、**単発のゲームとして公開しつつ、あとで BO5Arena にまとめられる** ようにするための共通の約束。
  Unity 版の `05_minigame_framework.md` と `06_network_reconnect.md` を、Web(PeerJS による P2P)に置き換えたもの。
- 最初の対応ゲームは MG01 Race(`document/race_design.md`)。以降のゲームもこの約束に従う。

## 1. 全体の形:ゲーム本体と枠を分ける

```
games/
  _shared/             ── 枠(全ゲーム共通)
    frame/             接続、名簿、時刻同期、切断・再接続の方針、ゲームの生成と破棄
    net/               PeerJS、ループバック、チャンネルの多重化
    standalone/        単発版の画面(タイトル、ロビー、結果、もう一度)
    core/rng.js        乱数
  race/                ── ゲーム本体(MG01)。index.html は standalone を呼ぶだけ
  <次のゲーム>/
  arena/(将来)       ── BO5Arena の枠。同じ frame を使い、ドラフトとスコアを足す
```

| 役割 | 枠(`_shared`) | ゲーム本体 |
|---|---|---|
| PeerJS の接続、合言葉、本人確認(playerId) | ○ | |
| 名簿(誰が何番か、ボット、接続中か) | ○ | |
| ホスト時刻の同期 | ○ | |
| 切断・再接続の方針(`onDisconnect`) | ○ | |
| 裏タブでも処理を止めないループ | ○ | |
| ロビー、結果画面、もう一度 | ○(単発版は standalone、BO5 は arena) | |
| カウントダウン、ゲームのルール、描画、HUD、入力 | | ○ |
| ボットの動き | | ○ |
| 勝敗と順位を決める | | ○(ホストで確定して枠に返す) |

- ゲーム本体は **PeerJS を直接触らない**。枠から渡される `GameNet`(4節)だけで通信する。
- 1つのゲームを単発版と BO5Arena で **コピーせずに共有する**。違いは3つの設定(5節)で吸収する。

## 2. ゲームの定義

各ゲームは `games/<id>/src/game.js` で次を export する。

```js
export const definition = {
  id: 'MG01',
  name: 'アイテムレース',
  description: '...',            // ロビーとBO5のカードに出す説明
  minPlayers: 1,                 // ボットを含めた最少人数(ボットがいれば1人で遊べる)
  maxPlayers: 8,                 // このゲームが対応する最大人数
  supportsBots: true,
  estimatedDurationSec: 120,
  createGame,                    // 3節
};
```

## 3. ライフサイクル

```
枠:ロビーで名簿が決まる → startGame(ホストが全員に通知)
 → 各端末で createGame(ctx)                  ゲームの生成(シーン・メッシュ・状態の準備)
 → ゲーム:カウントダウン(入力を止める)      開始時刻はホスト時刻で決める
 → ゲーム:プレイ
 → ゲーム(ホスト):ctx.onResult(result)     一度だけ呼ぶ
 → 枠:endGame を全員に通知 → 結果画面 → game.dispose()
 → もう一度:新しい seed で createGame から繰り返す
```

```ts
createGame(ctx: GameContext): GameInstance

GameContext {
  role: 'host' | 'guest'
  localSlot: number                // この端末で操作するプレイヤーの番号
  roster: Array<{ slot: number, name: string, kind: 'human' | 'bot', local: boolean }>
                                   // local: この端末で動かすか(ホストでは、自分とボットが true)
  seed: number                     // 乱数の種。乱数はすべてここから作る
  settings: object                 // ゲームの設定の上書き(5節の finishRule など)
  net: GameNet                     // 4節
  clock: { hostNow(): number }     // ホスト時刻(ms)
  log: (event: string, fields?: object) => void    // 出力は `[BO5][<id>] event key=value ...`
  dom: { canvas: HTMLCanvasElement, hudRoot: HTMLElement } | null   // ヘッドレスでは null
  onResult: (result: GameResult) => void           // ホストだけが呼ぶ
}

GameInstance {
  update(now: number): void        // 枠が固定の間隔で呼ぶ(裏タブでも止めない。6節)
  render(now: number): void        // 枠が requestAnimationFrame で呼ぶ(画面が見えているときだけ)
  onPlayerLeft(slot: number): void // レース中に誰かが抜けた(onDisconnect = 'continue' のとき)
  dispose(): void                  // DOM、イベント、WebGL の資源をすべて解放する
}

GameResult {
  ranking: number[]                // 1位から順の slot。途中で抜けた人は最後
  reason: string                   // 'finish' / 'timeout' など、ゲームごとの理由
  details?: object                 // タイムなど、結果画面に出したいもの
}
```

- 引き分けは返さない(`ranking` は必ず全員の順位になる)。BO5Arena は `ranking[0]` を勝者とする。
- ゲームは、必要ならホストの中で自分用のクライアントとボットのクライアントを作り、ループバックでホストの処理とつないでよい
  (Race はそうする)。

## 4. 通信(`GameNet`)

枠は、ゲームのメッセージを枠のメッセージと同じ接続に **チャンネルを分けて** 流す。
ゲームのメッセージには枠がゲームのインスタンス ID(`gi`)をつけ、**別のインスタンスあての古いメッセージは枠が捨てる**。
そのため、もう一度遊んだときや、やり直したときに、前のゲームのメッセージが紛れ込むことはない。

```ts
// ホスト側(リモートのプレイヤーとの通信。ホストの中のクライアントはゲームが自分でつなぐ)
HostGameNet {
  send(slot: number, msg: object): void
  broadcast(msg: object, exceptSlot?: number): void
  onMessage(fn: (slot: number, msg: object) => void): void
  remoteSlots(): number[]
}
// ゲスト側
GuestGameNet {
  send(msg: object): void
  onMessage(fn: (msg: object) => void): void
}
```

- メッセージは JSON にできるオブジェクト。ゲームのメッセージの種類は各ゲームが決める。
- 送信の順番は保たれる(PeerJS の reliable な DataConnection 1本)。

## 5. 単発版と BO5Arena の違いを吸収する設定

| 設定 | 持つ場所 | 単発版の既定 | BO5Arena | 意味 |
|---|---|---|---|---|
| `maxPlayers` | 枠 | `definition.maxPlayers`(Race は 8) | 2 | ロビーに入れる人数(ボットを含む) |
| `onDisconnect` | 枠 | `'continue'` | `'restart'` | ゲーム中の切断の扱い(7節) |
| `finishRule` | ゲームの settings | ゲームごと(Race は `'grace'`) | `'first'` | いつゲームを終えるか。`'first'` は1位が決まった時点で終える |

- 2人で遊ぶときに、元の1対1の仕様(Unity 版)と同じバランスになるように、各ゲームはテストで確かめる。

## 6. ループ(裏タブ対策)

- ブラウザは、裏に回ったタブの `requestAnimationFrame` を止める。**ホストの処理が止まると全員のゲームが止まる** ため、
  枠は `update` を描画と切り離して回す。
- `_shared/frame/ticker.js`:画面が見えている間は `requestAnimationFrame`、`document.hidden` の間は
  Web Worker(`ticker.worker.js`)の `setInterval(1000 / 60)` から `update(now)` を呼ぶ。
  Worker のタイマーは、メインスレッドのタイマーほど強く間引かれない。
- `render` は見えている間だけ呼ぶ。
- ゲストでも同じようにする(裏にしても通信の応答が止まらないように)。裏にした人の入力は、すべて離した扱いになる。

## 7. 接続・切断・再接続(枠が行う)

- **合言葉**:ホストの PeerJS ID は `bo5-{gameId または 'arena'}-{合言葉}`。その ID を取れたらホスト、取れなければゲストとして接続する。
  ゲストの ID はランダム。
- **本人確認**:`playerId` は `localStorage` に保存した UUID。同じ `playerId` が戻ってきたら同じ slot に戻す。
- **受け付け**:名簿が `maxPlayers` に達していれば `reject: 'full'`。プロトコルのバージョンが違えば `reject: 'version'`。
  ゲーム中に新しい人が来たら受け付けて「観戦待ち」にし、次のゲームから名簿に入れる。
- **ゲーム中にゲストが切断したとき**:
  - `onDisconnect = 'continue'`:ゲームは続ける。枠は全員の `game.onPlayerLeft(slot)` を呼ぶ。
    戻ってきたら観戦待ちになり、次のゲームから参加する。ゲームは、抜けた人を順位の最後に置く。
  - `onDisconnect = 'restart'`:ゲームを破棄して一時停止し、その人が戻るのを待つ(最長 120 秒。過ぎたら「さらに待つ / 終了する」)。
    戻ったら、新しい seed で `createGame` からやり直す(Unity 版 06 と同じ)。
- **ゲスト側で切断を検知したとき**:ゲーム中なら 3 秒ごとに再接続を試みる(最長 120 秒。手動で諦められる)。ロビーや結果画面での切断は再接続せず、タイトルに戻す。`reject` を受けたときも再接続しない。
- **ホストが切断したとき**:続けられない。ゲストは再接続を試み、戻らなければタイトルに戻す。
- **つながらない人が出るとき**:PeerJS の既定には中継サーバー(TURN)がない。枠の設定に `iceServers` を渡せるようにしておき、困ったら TURN を足す。

## 8. 枠のメッセージ(チャンネル `f`)

すべての送信は `{ c: 'f' | 'g', gi?: number, m: object }` の形で包む(`_shared/net/channel.js`)。`c = 'g'` がゲームのメッセージ。

| 向き | m.t | 中身 |
|---|---|---|
| ゲスト → ホスト | `hello` | `v, playerId, name` |
| ゲスト → ホスト | `ping` | `c`(ゲストの時刻) |
| ゲスト → ホスト | `leave` | – |
| ホスト → ゲスト | `welcome` | `slot, roster, phase` |
| ホスト → ゲスト | `reject` | `reason: 'full' \| 'version'` |
| ホスト → ゲスト | `pong` | `c, h`(ホスト時刻) |
| ホスト → ゲスト | `roster` | `players: [{ slot, name, kind, connected, waiting }]` |
| ホスト → ゲスト | `startGame` | `gi, gameId, seed, roster, settings` |
| ホスト → ゲスト | `playerLeft` | `gi, slot` |
| ホスト → ゲスト | `endGame` | `gi, result` |
| ホスト → ゲスト | `paused` / `resumed` | `onDisconnect = 'restart'` のとき |

- 時刻同期:ゲストは 1 秒ごとに `ping` を送り、`offset = h + (t1 - c) / 2 - t1` の直近 5 回の中央値を使う。
  `clock.hostNow() = performance.now() + offset`。ホストでは offset = 0。

## 9. ロビー(単発版 `standalone`)

- タイトル:表示名、合言葉、「部屋を作る / 入る」「ソロで遊ぶ」、操作説明(ゲームから受け取る)。
- ロビー:名簿(色つき)、合言葉。ホストだけが「ボットを追加 / 外す」「スタート」を押せる。人数は `maxPlayers` まで。
- 結果:`GameResult.ranking` と `details` を表にする。ホストが「もう一度」を押すと、次のゲームを始める。「ロビーへ」で名簿の編集に戻る。
- URL パラメータ(全ゲーム共通):`?room=`、`?name=`、`?solo=1`、`?bots=N`(ソロやホストでボットを N 台入れてすぐ始める)、`?debug=1`。
  ゲーム固有のパラメータは `settings` としてゲームに渡す。

## 10. テストの約束

- ゲームのロジックと枠は、**DOM・Three.js・PeerJS・実時刻・`Math.random` を使わずに Node で動かせる** ようにする。
  (ブラウザ専用のファイル:`_shared/net/peer.js`、`_shared/frame/ticker.js`、`ticker.worker.js`、`_shared/standalone/*`、各ゲームの `render/`・`ui/`・`input.js`)
- 各ゲームは、ループバックと偽の時計でホストとボットのクライアントをつなぎ、**ヘッドレスで何十回も遊ぶ結合テスト** を持つ。
- テストは `node --test`(追加パッケージなし)。`games/_shared/` と `games/<id>/` それぞれに `package.json`(`"type": "module"`)と `tests/` を置く。

## 11. 枠の実装(ファイルと API)

```
games/_shared/
  package.json            {"private": true, "type": "module", "scripts": {"test": "node --test tests/"}}
  core/rng.js             createRng(seed) → { next, range(a, b), int(n), pick(arr), shuffle(arr), fork() }(mulberry32)
  net/transport.js        Transport のインターフェース(JSDoc のみ)
  net/loopback.js         createLoopbackPair({ latencyMs = 0, jitterMs = 0, rng }) → [Transport, Transport]
  net/channel.js          wrapChannel(transport) → { frame: {send, onMessage}, game: {send(gi, m), onMessage(fn(gi, m))} }
  net/peer.js             connectRoom(gameId, room, { iceServers, onStatus }) → Promise<HostSide | GuestSide>(ブラウザ専用)
  frame/protocol.js       FRAME_VERSION と、8節のメッセージの作成関数
  frame/clock.js          createClockSync() → { onPong(c, h, t1), offset(), hostNow(localNow) }
  frame/roster.js         名簿の操作(空き slot の割り当て、playerId での復帰、ボットの追加と削除、waiting の扱い)
  frame/hostFrame.js      createHostFrame(opts)(下記)
  frame/guestFrame.js     createGuestFrame(opts)(下記)
  frame/ticker.js         createTicker(onUpdate, onRender)(ブラウザ専用。6節)
  frame/ticker.worker.js
  standalone/standalone.js  startStandalone(definition, { controlsHelp, parseSettings(urlParams) })(ブラウザ専用)
  standalone/lobby.js / standalone/lobby.css
  tests/
```

```ts
Transport {
  send(msg: object): void
  onMessage(fn: (msg) => void): void
  onClose(fn: () => void): void
  close(): void
  pump(now: number): void   // loopback は、届く時刻になったメッセージをここで配る。PeerJS は何もしない
}
```

- loopback は送るときに `JSON.parse(JSON.stringify(msg))` でコピーする(シリアライズできないものを混ぜたら気づけるように)。
  到着時刻 = 送った時刻 + `latencyMs` + jitter。順番は入れ替えない。`close()` で相手の `onClose` を呼ぶ。
  送った時刻は、最後に `pump(now)` された時刻を使う。

```ts
createHostFrame({
  definition, maxPlayers, onDisconnect, hostName, playerId,
  createGameCtxExtras: () => ({ dom, log }),   // ブラウザでは dom を渡す。ヘッドレスでは null
  reconnectWaitSec = 120,
  events: { onRoster, onGameStart, onGameEnd, onPaused, onResumed },
}) → {
  acceptTransport(transport)      // PeerJS の新しい接続(ヘッドレスでは loopback)を渡す。hello を待って名簿に入れる
  addBot(name?) / removeBot(slot)
  startGame(settings, now)        // 名簿を確定し、seed を作り、全員に startGame を送り、自分の createGame を呼ぶ
  backToLobby()
  update(now)                     // 受信の処理、時刻同期の応答、ゲームの update、再接続待ちのタイマー
  render(now)
  roster, phase: 'lobby' | 'inGame' | 'paused' | 'result'
}

createGuestFrame({ definition, name, playerId, transport, createGameCtxExtras, events: {...,onReject, onHostLost} })
  → { update(now), render(now), leave(), replaceTransport(transport) /* 再接続 */, roster, phase, localSlot }
```

- ゲームの `update` は、フレームの `update` の中で呼ぶ。ゲームの `ctx.clock.hostNow` は、ホストでは `now` そのもの、ゲストでは時刻同期の結果。
- ヘッドレスのテストでは、ホストの枠とゲストの枠を loopback でつなぎ、`now` を自分で進めて `update(now)` を呼ぶ。
