/**
 * 名簿(roster)の操作。空き slot の割り当て、playerId での復帰、ボットの追加と削除、
 * waiting(観戦待ち)の扱いをまとめる。hostFrame から呼ばれる純粋な操作の集まりで、
 * それ自身は通信もタイマーも持たない(テストしやすくするため)。
 *
 * 名簿の1エントリ:
 * { slot, name, kind: 'human'|'bot', local: boolean, playerId: string|null,
 *   connected: boolean, waiting: boolean }
 * - `local`: この端末(ホスト)がゲームを直接動かすか。ホスト自身とボットは true、リモートの人間は false。
 * - `waiting`: ゲーム開始後に入ってきた/ゲーム中に切断から戻ってきた人。次のゲームから名簿に入る。
 * - ボットは `playerId` を持たない(常に null)。
 */

/** 空の名簿を作る */
export function createRoster() {
  return [];
}

/** 使われている slot の集合から、0 始まりで最小の空き slot を返す */
function firstFreeSlot(roster) {
  const used = new Set(roster.map((p) => p.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * playerId で人間のプレイヤーを名簿に迎え入れる。
 * 既に同じ playerId のエントリがあれば、そこに復帰させる(slot は変えない)。
 * 新規なら空き slot に追加する。`maxPlayers` を超える場合は null を返す(呼び出し側で reject: 'full' にする)。
 * ゲーム中(inGame/paused)に新しく来た人は waiting にする。
 *
 * @returns {object|null} 追加/復帰したエントリ(roster 内のオブジェクトそのもの)。入れなければ null。
 */
export function joinHuman(roster, { playerId, name, maxPlayers, gameInProgress }) {
  const existing = roster.find((p) => p.kind === 'human' && p.playerId === playerId);
  if (existing) {
    existing.name = name;
    existing.connected = true;
    // ゲーム中の復帰は observ 待ち。ロビー・結果画面での復帰はそのまま名簿に戻る。
    if (gameInProgress) existing.waiting = true;
    return existing;
  }

  if (roster.length >= maxPlayers) return null;

  const entry = {
    slot: firstFreeSlot(roster),
    name,
    kind: 'human',
    local: false,
    playerId,
    connected: true,
    waiting: !!gameInProgress,
  };
  roster.push(entry);
  return entry;
}

/**
 * ボットを追加する。名前を省略したら「BOT 1」のように、既存のボットの数 + 1 で番号を振る。
 * @returns {object|null} 追加したエントリ。`maxPlayers` を超えるなら null。
 */
export function addBot(roster, name, { maxPlayers } = {}) {
  if (maxPlayers != null && roster.length >= maxPlayers) return null;
  const botCount = roster.filter((p) => p.kind === 'bot').length;
  const entry = {
    slot: firstFreeSlot(roster),
    name: name || `BOT ${botCount + 1}`,
    kind: 'bot',
    local: true,
    playerId: null,
    connected: true,
    waiting: false,
  };
  roster.push(entry);
  return entry;
}

/** slot を指定してボット(または人間)を名簿から取り除く。取り除けたら true */
export function removeBySlot(roster, slot) {
  const idx = roster.findIndex((p) => p.slot === slot);
  if (idx === -1) return false;
  roster.splice(idx, 1);
  return true;
}

/** playerId の人を「切断中」にする(名簿からは消さない。戻ってこられるように) */
export function markDisconnected(roster, playerId) {
  const entry = roster.find((p) => p.kind === 'human' && p.playerId === playerId);
  if (entry) entry.connected = false;
  return entry ?? null;
}

/**
 * ゲーム開始:今 connected な(waiting でない)人とボットを、そのゲームの参加者として確定する。
 * waiting の人はこのラウンドには含めない。
 * @returns {Array<object>} 参加者のコピー(slot 昇順)
 */
export function confirmedForGame(roster) {
  return roster
    .filter((p) => p.connected && !p.waiting)
    .slice()
    .sort((a, b) => a.slot - b.slot);
}

/** 次のゲームに向けて、waiting だった人を名簿に迎え入れる(waiting を false に戻す) */
export function admitWaiting(roster) {
  for (const p of roster) {
    if (p.waiting) p.waiting = false;
  }
}

/** ホストからゲストへ送る `roster` メッセージの `players` の形に変換する(約束 8節) */
export function toWireRoster(roster) {
  return roster
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ slot: p.slot, name: p.name, kind: p.kind, connected: p.connected, waiting: p.waiting }));
}

/** GameContext.roster の形に変換する(約束 3節)。`local` を含み、`playerId`/`connected`/`waiting` は含めない */
export function toGameRoster(roster) {
  return roster
    .slice()
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({ slot: p.slot, name: p.name, kind: p.kind, local: p.local }));
}
