/**
 * 単発版(standalone)の画面の描画(約束 9節)。DOM を直接組み立てるだけの薄い層で、
 * 状態は持たない(`standalone.js` が状態を持ち、変わるたびにここの `render*` を呼び直す)。
 */

const KIND_LABEL = { human: '人', bot: 'ボット' };
/** details.results[].status の表示名(知らない値はそのまま出す) */
const STATUS_LABEL = { finished: 'ゴール', racing: '走行中', left: 'DNF(退出)' };

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function clear(root) {
  root.innerHTML = '';
}

/** すべての画面を隠す(#lobby を空にする) */
export function hide(root) {
  clear(root);
}

/**
 * タイトル画面:表示名、合言葉、「部屋を作る / 入る」「ソロで遊ぶ」、操作説明。
 * @param {HTMLElement} root
 * @param {{ definition: object, name: string, room: string, controlsHelp?: string, error?: string,
 *   onSolo: (name: string) => void, onJoin: (name: string, room: string) => void }} p
 */
export function renderTitle(root, p) {
  const { definition, name, room, controlsHelp, error } = p;
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  box.innerHTML = `
    <h1>${escapeHtml(definition.name || definition.id)}</h1>
    <p class="bo5-sub">${escapeHtml(definition.description || '')}</p>
    ${error ? `<div class="bo5-error">${escapeHtml(error)}</div>` : ''}
    <div class="bo5-field">
      <label for="bo5-name">表示名</label>
      <input id="bo5-name" type="text" maxlength="16" value="${escapeHtml(name)}" placeholder="名前">
    </div>
    <div class="bo5-field">
      <label for="bo5-room">合言葉</label>
      <input id="bo5-room" type="text" maxlength="24" value="${escapeHtml(room)}" placeholder="例: fox42">
    </div>
    <div class="bo5-row">
      <button type="button" class="bo5-btn bo5-btn-primary" id="bo5-join-btn">部屋を作る / 入る</button>
      <button type="button" class="bo5-btn" id="bo5-solo-btn">ソロで遊ぶ</button>
    </div>
    ${controlsHelp ? `<div class="bo5-help">${escapeHtml(controlsHelp)}</div>` : ''}
  `;
  root.appendChild(box);

  const nameInput = box.querySelector('#bo5-name');
  const roomInput = box.querySelector('#bo5-room');
  box.querySelector('#bo5-join-btn').addEventListener('click', () => {
    p.onJoin(nameInput.value.trim(), roomInput.value.trim());
  });
  box.querySelector('#bo5-solo-btn').addEventListener('click', () => {
    p.onSolo(nameInput.value.trim());
  });
}

/** 接続中の画面(ホスト確保 / ゲスト接続の途中) */
export function renderConnecting(root, { status, onCancel }) {
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  box.innerHTML = `
    <h1>接続しています</h1>
    <div class="bo5-status"><span class="bo5-spinner"></span><span id="bo5-status-text">${escapeHtml(status || '')}</span></div>
    <div class="bo5-row"><button type="button" class="bo5-btn" id="bo5-cancel-btn">やめる</button></div>
  `;
  root.appendChild(box);
  box.querySelector('#bo5-cancel-btn').addEventListener('click', onCancel);
}

function kindBadge(kind) {
  const cls = kind === 'bot' ? 'bo5-badge-bot' : 'bo5-badge-human';
  return `<span class="bo5-badge ${cls}">${escapeHtml(KIND_LABEL[kind] || kind)}</span>`;
}

function connBadge(entry) {
  if (entry.kind === 'bot') return '<span class="bo5-badge bo5-badge-human">-</span>';
  if (entry.waiting) return '<span class="bo5-badge bo5-badge-wait">観戦待ち</span>';
  return entry.connected
    ? '<span class="bo5-badge bo5-badge-human">接続中</span>'
    : '<span class="bo5-badge bo5-badge-off">切断中</span>';
}

/**
 * ロビー(名簿・合言葉・ホストの操作)。
 * @param {HTMLElement} root
 * @param {{ definition: object, roster: Array<object>, room: string, isHost: boolean, localSlot: number,
 *   maxPlayers: number, onAddBot: () => void, onRemoveBot: (slot: number) => void, onStart: () => void,
 *   onLeave: () => void }} p
 */
export function renderLobby(root, p) {
  const { definition, roster, room, isHost, localSlot, maxPlayers } = p;
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  const rows = roster
    .map((entry) => {
      const isMe = entry.slot === localSlot;
      const removeBtn =
        isHost && entry.kind === 'bot'
          ? `<button type="button" class="bo5-btn bo5-btn-ghost" data-remove="${entry.slot}" style="padding:2px 8px;min-width:0;">外す</button>`
          : '';
      return `<tr${isMe ? ' style="color:#7fb2f0;"' : ''}>
        <td>${entry.slot + 1}</td>
        <td>${escapeHtml(entry.name)}${isMe ? ' (自分)' : ''}</td>
        <td>${kindBadge(entry.kind)}</td>
        <td>${connBadge(entry)}</td>
        <td>${removeBtn}</td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <h1>${escapeHtml(definition.name || definition.id)}</h1>
    <div class="bo5-room-code">合言葉: <strong>${escapeHtml(room)}</strong></div>
    <table class="bo5-table">
      <thead><tr><th>#</th><th>名前</th><th>種類</th><th>状態</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="bo5-hint">${roster.length} / ${maxPlayers} 人</div>
    ${
      isHost
        ? `<div class="bo5-row">
             <button type="button" class="bo5-btn" id="bo5-addbot-btn" ${roster.length >= maxPlayers ? 'disabled' : ''}>ボットを追加</button>
             <button type="button" class="bo5-btn bo5-btn-primary" id="bo5-start-btn" ${roster.length < 1 ? 'disabled' : ''}>スタート</button>
           </div>`
        : `<p class="bo5-hint">ホストがスタートするのを待っています…</p>`
    }
    <div class="bo5-row"><button type="button" class="bo5-btn bo5-btn-ghost" id="bo5-leave-btn">タイトルへ戻る</button></div>
  `;
  root.appendChild(box);

  if (isHost) {
    box.querySelector('#bo5-addbot-btn')?.addEventListener('click', p.onAddBot);
    box.querySelector('#bo5-start-btn')?.addEventListener('click', p.onStart);
    box.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => p.onRemoveBot(Number(btn.dataset.remove)));
    });
  }
  box.querySelector('#bo5-leave-btn').addEventListener('click', p.onLeave);
}

/** ゲストが再接続を試みている間の画面(約束 7節:最長 120 秒、手動で諦められる) */
export function renderReconnecting(root, { secondsLeft, status, onGiveUp }) {
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  box.innerHTML = `
    <h1>再接続しています</h1>
    <div class="bo5-status"><span class="bo5-spinner"></span><span>${escapeHtml(status || 'ホストへ再接続しています…')}</span></div>
    <p class="bo5-hint">あと ${Math.max(0, Math.ceil(secondsLeft))} 秒であきらめます</p>
    <div class="bo5-row"><button type="button" class="bo5-btn bo5-btn-danger" id="bo5-giveup-btn">あきらめる</button></div>
  `;
  root.appendChild(box);
  box.querySelector('#bo5-giveup-btn').addEventListener('click', onGiveUp);
}

/** 接続できなかった/再接続をあきらめた/reject された、のあとの画面 */
export function renderLost(root, { reason, onBack }) {
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  box.innerHTML = `
    <h1>接続が切れました</h1>
    <div class="bo5-error">${escapeHtml(reason || '')}</div>
    <div class="bo5-row"><button type="button" class="bo5-btn bo5-btn-primary" id="bo5-back-btn">タイトルへ戻る</button></div>
  `;
  root.appendChild(box);
  box.querySelector('#bo5-back-btn').addEventListener('click', onBack);
}

/** ホスト側:onDisconnect='restart' の一時停止が reconnectWaitSec を超えたときの画面 */
export function renderPausedHost(root, { secondsWaited, onWaitMore, onEnd }) {
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';
  box.innerHTML = `
    <h1>相手を待っています</h1>
    <p class="bo5-hint">${Math.floor(secondsWaited)} 秒待っています。もう少し待ちますか?</p>
    <div class="bo5-row">
      <button type="button" class="bo5-btn bo5-btn-primary" id="bo5-waitmore-btn">さらに待つ</button>
      <button type="button" class="bo5-btn bo5-btn-danger" id="bo5-end-btn">終了する</button>
    </div>
  `;
  root.appendChild(box);
  box.querySelector('#bo5-waitmore-btn').addEventListener('click', onWaitMore);
  box.querySelector('#bo5-end-btn').addEventListener('click', onEnd);
}

/**
 * 結果画面:`GameResult.ranking` と `details` を表にする(約束 9節)。
 * @param {HTMLElement} root
 * @param {{ definition: object, result: object, roster: Array<object>, isHost: boolean,
 *   onAgain: () => void, onBackToLobby: () => void }} p
 */
export function renderResult(root, p) {
  const { result, roster, isHost } = p;
  clear(root);
  const box = document.createElement('div');
  box.className = 'bo5';

  const nameOf = (slot) => roster.find((r) => r.slot === slot)?.name ?? `#${slot + 1}`;
  const detailsBySlot = new Map();
  const detailRows = Array.isArray(result?.details?.results) ? result.details.results : null;
  if (detailRows) {
    for (const d of detailRows) detailsBySlot.set(d.slot, d);
  }

  const ranking = Array.isArray(result?.ranking) ? result.ranking : [];
  const rows = ranking
    .map((slot, i) => {
      const d = detailsBySlot.get(slot);
      // race の details.results は timeMs(ミリ秒)。time(秒)を返すゲームにも対応する。
      const sec = d ? (d.timeMs != null ? d.timeMs / 1000 : d.time) : null;
      const time = sec != null ? formatTime(sec) : '-';
      const status = d && d.status ? escapeHtml(STATUS_LABEL[d.status] || String(d.status)) : '';
      return `<tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(nameOf(slot))}</td>
        <td>${time}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');

  box.innerHTML = `
    <h1>結果</h1>
    <p class="bo5-hint">理由: ${escapeHtml(result?.reason ?? '')}</p>
    <table class="bo5-table">
      <thead><tr><th>順位</th><th>名前</th><th>タイム</th><th>状態</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${
      isHost
        ? `<div class="bo5-row">
             <button type="button" class="bo5-btn bo5-btn-primary" id="bo5-again-btn">もう一度</button>
             <button type="button" class="bo5-btn" id="bo5-tolobby-btn">ロビーへ</button>
           </div>`
        : `<p class="bo5-hint">ホストが「もう一度」を押すのを待っています…</p>`
    }
  `;
  root.appendChild(box);

  if (isHost) {
    box.querySelector('#bo5-again-btn').addEventListener('click', p.onAgain);
    box.querySelector('#bo5-tolobby-btn').addEventListener('click', p.onBackToLobby);
  }
}

function formatTime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-';
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${s}` : `${s}s`;
}

/** ?debug=1 のデバッグオーバーレイ(画面の隅) */
export function renderDebug(el, { phase, rtt, fps }) {
  const rttText = rtt == null ? '-' : `${Math.round(rtt)}ms`;
  el.textContent = `phase: ${phase}\nrtt: ${rttText}\nfps: ${fps == null ? '-' : Math.round(fps)}`;
}
