/**
 * 軍儀 (Gungi) - 描画・DOM操作レイヤー
 * ゲーム状態(engine.jsが管理)を受け取って画面を更新するだけの純粋な描画関数群。
 * クリック時の判定・アクション実行は main.js が担当し、コールバック経由でここへ繋ぐ。
 */
(function (root) {
  'use strict';
  var P = root.Gungi.Pieces;
  var BOARD_SIZE = P.BOARD_SIZE;

  var DIR_LABEL = { F: '前', B: '後', L: '左', R: '右', FL: '左前', FR: '右前', BL: '左後', BR: '右後' };

  var els = {};
  var cellEls = {}; // "x,y" -> element
  var onCellClickCb = null;
  var onHandClickCb = null;

  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    ['setup-screen', 'mode-screen', 'game-screen',
      'status-line', 'room-name', 'join-btn',
      'my-role-label', 'mode-host-picker', 'mode-guest-waiting', 'start-manual-btn', 'start-quick-btn',
      'turn-indicator', 'check-banner',
      'pass-placement-btn', 'autofill-btn', 'resign-btn',
      'opp-hand-title', 'opp-hand-tray', 'opp-grave-tray',
      'my-hand-title', 'my-hand-tray', 'my-grave-tray',
      'stack-detail-list', 'log-list',
      'col-labels', 'row-labels', 'board',
      'help-modal', 'help-btn-setup', 'help-btn-game', 'help-close-btn', 'piece-legend', 'help-fab',
      'gameover-modal', 'result-line', 'reason-line', 'rematch-btn', 'rematch-status',
    ].forEach(function (id) { els[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = $(id); });
  }

  function showScreen(name) {
    ['setup-screen', 'mode-screen', 'game-screen'].forEach(function (id) {
      $(id).classList.toggle('active', id === name);
    });
  }

  function coordsFor(r, c, myOwner) {
    if (myOwner === 0) return { x: c, y: 10 - r };
    return { x: 10 - c, y: r };
  }

  function buildBoard(myOwner, cellClickHandler) {
    onCellClickCb = cellClickHandler;
    els.board.innerHTML = '';
    cellEls = {};
    for (var r = 1; r <= BOARD_SIZE; r++) {
      for (var c = 1; c <= BOARD_SIZE; c++) {
        var pos = coordsFor(r, c, myOwner);
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = pos.x;
        cell.dataset.y = pos.y;
        cell.addEventListener('click', function () {
          var x = parseInt(this.dataset.x, 10), y = parseInt(this.dataset.y, 10);
          if (onCellClickCb) onCellClickCb(x, y);
        });
        els.board.appendChild(cell);
        cellEls[pos.x + ',' + pos.y] = cell;
      }
    }

    // 列ラベル(左→右)
    els.colLabels.innerHTML = '';
    for (c = 1; c <= BOARD_SIZE; c++) {
      var x = myOwner === 0 ? c : (10 - c);
      var lab = document.createElement('span');
      lab.textContent = x;
      els.colLabels.appendChild(lab);
    }
    // 行ラベル(上→下)
    els.rowLabels.innerHTML = '';
    for (r = 1; r <= BOARD_SIZE; r++) {
      var y = myOwner === 0 ? (10 - r) : r;
      var lab2 = document.createElement('div');
      lab2.style.height = 'var(--cell-size, 52px)';
      lab2.style.display = 'flex';
      lab2.style.alignItems = 'center';
      lab2.textContent = y;
      els.rowLabels.appendChild(lab2);
    }
  }

  function pieceName(type) { return P.PIECES[type].name; }

  function renderCell(state, x, y, myOwner, highlight) {
    var cell = cellEls[x + ',' + y];
    if (!cell) return;
    var stack = state.board[x][y];

    cell.innerHTML = '';
    cell.classList.remove('territory-mine', 'territory-theirs', 'clickable', 'sui-check');
    var myRows = myOwner === 0 ? [1, 2, 3] : [7, 8, 9];
    var oppRows = myOwner === 0 ? [7, 8, 9] : [1, 2, 3];
    if (myRows.indexOf(y) !== -1) cell.classList.add('territory-mine');
    if (oppRows.indexOf(y) !== -1) cell.classList.add('territory-theirs');

    if (stack.length) {
      var wrap = document.createElement('div');
      wrap.className = 'piece-stack';
      stack.forEach(function (p, i) {
        var tile = document.createElement('div');
        tile.className = 'piece-tile owner-' + p.owner + ' tier-' + Math.min(i, 2) + (i === stack.length - 1 ? ' tier-top' : '');
        tile.textContent = pieceName(p.type);
        wrap.appendChild(tile);
      });
      if (stack.length > 1) {
        var badge = document.createElement('div');
        badge.className = 'stack-badge';
        badge.textContent = '×' + stack.length;
        wrap.appendChild(badge);
      }
      var top = stack[stack.length - 1];
      if (top.type === 'sui' && state.check === top.owner) {
        cell.classList.add('sui-check');
      }
      cell.appendChild(wrap);
    }

    if (highlight && highlight[x + ',' + y]) {
      var dot = document.createElement('div');
      dot.className = 'hint-dot ' + highlight[x + ',' + y];
      cell.appendChild(dot);
      cell.classList.add('clickable');
    }
  }

  function renderBoard(state, myOwner, highlight, selectedOrigin, inspecting) {
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        renderCell(state, x, y, myOwner, highlight);
        var cell = cellEls[x + ',' + y];
        cell.classList.toggle('selected-origin', !!(selectedOrigin && selectedOrigin.x === x && selectedOrigin.y === y));
        cell.classList.toggle('inspecting', !!(inspecting && inspecting.x === x && inspecting.y === y));
      }
    }
  }

  function renderHandTray(container, hand, owner, opts) {
    opts = opts || {};
    container.innerHTML = '';
    P.PIECE_ORDER.forEach(function (type) {
      var count = hand[type];
      var box = document.createElement('div');
      box.className = 'hand-piece owner-' + owner + (count === 0 ? ' disabled' : '') +
        (opts.selectedType === type ? ' selected' : '');
      box.textContent = pieceName(type);
      box.title = pieceName(type) + (count === 0 ? ' (在庫なし)' : ' 残り' + count);
      if (P.SPECIAL_PIECES.indexOf(type) !== -1) {
        var flag = document.createElement('div');
        flag.className = 'special-flag';
        flag.textContent = '★';
        box.appendChild(flag);
      }
      var badge = document.createElement('div');
      badge.className = 'count-badge';
      badge.textContent = count;
      box.appendChild(badge);
      if (opts.clickable && count > 0) {
        box.addEventListener('click', function () { if (onHandClickCb) onHandClickCb(owner, type); });
      }
      container.appendChild(box);
    });
  }

  function renderGraveTray(container, list) {
    container.innerHTML = '';
    if (!list.length) {
      var e = document.createElement('span');
      e.className = 'note';
      e.textContent = 'まだありません';
      container.appendChild(e);
      return;
    }
    list.forEach(function (p) {
      var box = document.createElement('div');
      box.className = 'grave-piece owner-' + p.owner;
      box.textContent = pieceName(p.type);
      container.appendChild(box);
    });
  }

  function renderStackDetail(state, pos) {
    els.stackDetailList.innerHTML = '';
    if (!pos) {
      var e = document.createElement('div');
      e.id = 'stack-detail-empty';
      e.textContent = 'マスをクリックすると詳細が表示されます';
      els.stackDetailList.appendChild(e);
      return;
    }
    var stack = state.board[pos.x][pos.y];
    var title = document.createElement('div');
    title.className = 'note';
    title.textContent = pos.x + '列 ' + pos.y + '行';
    els.stackDetailList.appendChild(title);
    if (!stack.length) {
      var e2 = document.createElement('div');
      e2.id = 'stack-detail-empty';
      e2.textContent = '(空きマス)';
      els.stackDetailList.appendChild(e2);
      return;
    }
    stack.forEach(function (p, i) {
      var row = document.createElement('div');
      row.className = 'tier-row';
      var num = document.createElement('div');
      num.className = 'tier-num';
      num.textContent = i + 1;
      var tag = document.createElement('div');
      tag.className = 'hand-piece owner-' + p.owner;
      tag.style.width = '26px'; tag.style.height = '26px'; tag.style.fontSize = '13px';
      tag.textContent = pieceName(p.type);
      var label = document.createElement('span');
      label.textContent = (p.owner === 0 ? '先手' : '後手') + ' ' + P.PIECES[p.type].name + P.PIECES[p.type].kana;
      row.appendChild(num); row.appendChild(tag); row.appendChild(label);
      els.stackDetailList.appendChild(row);
    });
  }

  function renderTurnIndicator(state, myOwner) {
    var text;
    if (state.phase === 'placement') {
      text = (state.turn === myOwner ? 'あなたの配置番です' : '相手の配置番です') +
        '(' + (state.turn === 0 ? '先手' : '後手') + ')';
    } else if (state.phase === 'play') {
      text = (state.turn === myOwner ? 'あなたの手番です' : '相手の手番です') +
        '(' + (state.turn === 0 ? '先手' : '後手') + ')';
    } else {
      text = '対局終了';
    }
    els.turnIndicator.textContent = text;
    els.turnIndicator.classList.toggle('my-turn', state.turn === myOwner && state.phase !== 'ended');
    els.checkBanner.classList.toggle('show', state.check === myOwner && state.phase === 'play');
  }

  function addLog(text) {
    var line = document.createElement('div');
    line.textContent = text;
    els.logList.appendChild(line);
  }

  function clearLog() { els.logList.innerHTML = ''; }

  function showModal(id) { $(id).classList.add('show'); }
  function hideModal(id) { $(id).classList.remove('show'); }

  function describePieceRanges(def) {
    var lines = [];
    if (def.kind === 'rider') {
      var s = def.straightUnlimited ? '無制限' : [1, 2, 3].map(function (t) { return def.straightFn('F', t); }).join('→');
      var d = def.diagUnlimited ? '無制限' : [1, 2, 3].map(function (t) { return def.diagFn('FL', t); }).join('→');
      lines.push('タテヨコ: ' + s + (def.straightUnlimited ? '' : '(段1→2→3)'));
      lines.push('ナナメ: ' + d + (def.diagUnlimited ? '' : '(段1→2→3)'));
      return lines;
    }
    def.dirs.forEach(function (dirKey) {
      var vals = [1, 2, 3].map(function (t) { return def.rangeFn(dirKey, t); });
      var label = DIR_LABEL[dirKey];
      if (vals[0] >= 90) {
        lines.push(label + ': 盤端まで' + (def.kind === 'jumper' ? '(飛越え可)' : ''));
      } else {
        lines.push(label + ': ' + vals.join('→') + (def.kind === 'jumper' ? ' (飛越え可)' : ''));
      }
    });
    return lines;
  }

  function populateLegend() {
    els.pieceLegend.innerHTML = '';
    P.PIECE_ORDER.forEach(function (type) {
      var def = P.PIECES[type];
      var box = document.createElement('div');
      box.className = 'piece-legend-item';
      var b = document.createElement('b');
      b.textContent = def.name + '(' + def.kana + ') ×' + def.count;
      box.appendChild(b);
      var ul = document.createElement('div');
      ul.style.marginTop = '4px';
      describePieceRanges(def).forEach(function (line) {
        var d = document.createElement('div');
        d.textContent = line;
        ul.appendChild(d);
      });
      if (def.special === 'marshal') {
        var m = document.createElement('div'); m.className = 'note'; m.textContent = '取られたら敗北。';
        ul.appendChild(m);
      }
      if (def.special === 'turncoat') {
        var m2 = document.createElement('div'); m2.className = 'note'; m2.textContent = '★特殊: 敵駒を寝返らせられる。';
        ul.appendChild(m2);
      }
      box.appendChild(ul);
      els.pieceLegend.appendChild(box);
    });
  }

  root.Gungi = root.Gungi || {};
  root.Gungi.UI = {
    cacheEls: cacheEls,
    showScreen: showScreen,
    buildBoard: buildBoard,
    renderBoard: renderBoard,
    renderHandTray: renderHandTray,
    renderGraveTray: renderGraveTray,
    renderStackDetail: renderStackDetail,
    renderTurnIndicator: renderTurnIndicator,
    addLog: addLog,
    clearLog: clearLog,
    showModal: showModal,
    hideModal: hideModal,
    populateLegend: populateLegend,
    setOnHandClick: function (cb) { onHandClickCb = cb; },
    els: function () { return els; },
  };
})(typeof window !== 'undefined' ? window : this);
