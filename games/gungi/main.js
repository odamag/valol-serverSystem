/**
 * 軍儀 (Gungi) - 画面制御・通信アクションの橋渡し
 */
(function () {
  'use strict';
  var Engine = window.Gungi.Engine;
  var UI = window.Gungi.UI;
  var Net = window.Gungi.Net;
  var P = window.Gungi.Pieces;

  var myOwner = null;
  var state = null;
  var inspecting = null;
  var selection = null; // {mode:'board'|'hand', originX, originY, handType, targets:[{x,y,kind,...}]}
  var rematchReady = [false, false];
  var pieceLabel = function (t) { return P.PIECES[t].name; };

  function resetSelection() { selection = null; }

  // ============ 起動時の配線 ============
  document.addEventListener('DOMContentLoaded', function () {
    UI.cacheEls();
    UI.populateLegend();
    UI.setOnHandClick(onHandClick);

    var els = UI.els();
    els.helpBtnSetup.addEventListener('click', function () { UI.showModal('help-modal'); });
    els.helpBtnGame.addEventListener('click', function () { UI.showModal('help-modal'); });
    els.helpFab.addEventListener('click', function () { UI.showModal('help-modal'); });
    els.helpCloseBtn.addEventListener('click', function () { UI.hideModal('help-modal'); });

    els.joinBtn.addEventListener('click', function () {
      els.joinBtn.disabled = true;
      Net.join(els.roomName.value.trim());
    });

    els.startManualBtn.addEventListener('click', function () {
      state = Engine.createInitialState();
      Net.send({ t: 'MODE', mode: 'manual' });
      enterGame();
    });
    els.startQuickBtn.addEventListener('click', function () {
      state = Engine.createInitialState();
      Engine.quickStartBothDefault(state);
      Net.send({ t: 'MODE', mode: 'quick' });
      enterGame();
    });

    els.passPlacementBtn.addEventListener('click', function () {
      var r = Engine.passPlacement(state);
      if (r.ok) { Net.send({ t: 'ACTION', kind: 'pass' }); resetSelection(); afterLocalAction(); }
    });
    els.autofillBtn.addEventListener('click', function () {
      var r = Engine.autoFillRemaining(state, myOwner);
      if (r.ok) { Net.send({ t: 'ACTION', kind: 'autofill', owner: myOwner }); resetSelection(); afterLocalAction(); }
    });
    var resignArmed = false;
    var resignArmTimer = null;
    els.resignBtn.addEventListener('click', function () {
      if (!state || state.result) return;
      if (!resignArmed) {
        resignArmed = true;
        els.resignBtn.textContent = '本当に投了しますか？(もう一度押す)';
        resignArmTimer = setTimeout(function () {
          resignArmed = false;
          els.resignBtn.textContent = '投了';
        }, 4000);
        return;
      }
      clearTimeout(resignArmTimer);
      resignArmed = false;
      els.resignBtn.textContent = '投了';
      Engine.resign(state, myOwner);
      Net.send({ t: 'ACTION', kind: 'resign', owner: myOwner });
      afterLocalAction();
    });
    els.rematchBtn.addEventListener('click', function () {
      rematchReady[myOwner] = true;
      els.rematchBtn.disabled = true;
      Net.send({ t: 'REMATCH' });
      updateRematchStatus();
      maybeStartRematch();
    });

    wireNet();
  });

  function updateRematchStatus() {
    var els = UI.els();
    els.rematchStatus.textContent =
      (rematchReady[0] ? '先手:OK ' : '先手:待機 ') + (rematchReady[1] ? '後手:OK' : '後手:待機');
  }

  function maybeStartRematch() {
    if (rematchReady[0] && rematchReady[1]) {
      rematchReady = [false, false];
      UI.hideModal('gameover-modal');
      UI.els().rematchBtn.disabled = false;
      UI.showScreen('mode-screen');
      if (myOwner === 0) {
        UI.els().modeHostPicker.style.display = 'flex';
        UI.els().modeGuestWaiting.style.display = 'none';
      } else {
        UI.els().modeHostPicker.style.display = 'none';
        UI.els().modeGuestWaiting.style.display = 'block';
      }
    }
  }

  // ============ ネットワーク ============
  function wireNet() {
    var els = UI.els();
    Net.on('status', function (msg) { els.statusLine.textContent = msg; });
    Net.on('error', function () { els.joinBtn.disabled = false; });
    Net.on('connected', function (info) {
      myOwner = info.isHost ? 0 : 1;
      UI.showScreen('mode-screen');
      els.myRoleLabel.textContent = 'あなたは' + (myOwner === 0 ? '先手(ホスト)' : '後手(ゲスト)') + 'です。';
      if (myOwner === 0) {
        els.modeHostPicker.style.display = 'flex';
        els.modeGuestWaiting.style.display = 'none';
      } else {
        els.modeHostPicker.style.display = 'none';
        els.modeGuestWaiting.style.display = 'block';
      }
    });
    Net.on('disconnected', function () {
      alert('通信が切断されました');
      location.reload();
    });
    Net.on('data', onRemoteData);
  }

  function onRemoteData(data) {
    if (data.t === 'MODE') {
      state = Engine.createInitialState();
      if (data.mode === 'quick') Engine.quickStartBothDefault(state);
      enterGame();
      return;
    }
    if (data.t === 'ACTION') {
      applyRemoteAction(data);
      resetSelection();
      afterLocalAction();
      return;
    }
    if (data.t === 'REMATCH') {
      var remoteOwner = 1 - myOwner;
      rematchReady[remoteOwner] = true;
      updateRematchStatus();
      maybeStartRematch();
    }
  }

  function applyRemoteAction(data) {
    switch (data.kind) {
      case 'place': Engine.place(state, data.pieceType, data.x, data.y); break;
      case 'pass': Engine.passPlacement(state); break;
      case 'autofill': Engine.autoFillRemaining(state, data.owner); break;
      case 'move': Engine.move(state, data.fromX, data.fromY, data.toX, data.toY); break;
      case 'arata': Engine.arata(state, data.pieceType, data.x, data.y); break;
      case 'turncoat': Engine.turncoat(state, data.x, data.y); break;
      case 'resign': Engine.resign(state, data.owner); break;
    }
  }

  // ============ ゲーム開始 ============
  function enterGame() {
    UI.showScreen('game-screen');
    UI.buildBoard(myOwner, onCellClick);
    UI.clearLog();
    resetSelection();
    inspecting = null;
    UI.addLog('対局開始 (' + (state.phase === 'play' ? '固定配置' : '自由配置') + ')');
    render();
  }

  // ============ 描画更新 ============
  function highlightMapFromSelection() {
    var map = {};
    if (selection) {
      selection.targets.forEach(function (t) { map[t.x + ',' + t.y] = t.kind; });
    }
    return map;
  }

  function render() {
    var els = UI.els();
    var highlight = highlightMapFromSelection();
    var origin = selection && selection.mode === 'board' ? { x: selection.originX, y: selection.originY } : null;
    UI.renderBoard(state, myOwner, highlight, origin, inspecting);
    UI.renderTurnIndicator(state, myOwner);

    var oppOwner = 1 - myOwner;
    els.myHandTitle.textContent = '自分の持ち駒' + (state.phase !== 'ended' ? '(クリックして選択)' : '');
    UI.renderHandTray(els.myHandTray, state.hands[myOwner], myOwner, {
      clickable: canAct(myOwner),
      selectedType: selection && selection.mode === 'hand' ? selection.handType : null,
    });
    UI.renderHandTray(els.oppHandTray, state.hands[oppOwner], oppOwner, { clickable: false });
    UI.renderGraveTray(els.myGraveTray, state.graveyard[myOwner]);
    UI.renderGraveTray(els.oppGraveTray, state.graveyard[oppOwner]);
    UI.renderStackDetail(state, inspecting);

    // 配置フェーズ用ボタン
    var inPlacement = state.phase === 'placement';
    var myPlacementTurn = inPlacement && state.turn === myOwner && !state.placementPassed[myOwner];
    els.passPlacementBtn.style.display = inPlacement ? 'inline-block' : 'none';
    els.passPlacementBtn.disabled = !(myPlacementTurn && state.suiPlaced[myOwner]);
    els.autofillBtn.style.display = inPlacement ? 'inline-block' : 'none';
    els.autofillBtn.disabled = !myPlacementTurn;
    els.resignBtn.disabled = state.phase === 'ended';

    if (state.result && state.phase === 'ended') showGameOver();
  }

  function canAct(owner) {
    if (!state || state.result) return false;
    if (owner !== myOwner) return false;
    if (state.phase === 'placement') return state.turn === myOwner && !state.placementPassed[myOwner];
    if (state.phase === 'play') return state.turn === myOwner;
    return false;
  }

  // ============ クリック処理 ============
  function onCellClick(x, y) {
    inspecting = { x: x, y: y };

    if (selection && selection.targets.some(function (t) { return t.x === x && t.y === y; })) {
      commitSelectionTo(x, y);
      return;
    }

    if (!state || state.result) { render(); return; }

    if (state.phase === 'placement') {
      // 配置フェーズはハンドから選んでマスをクリックする流れなので、盤面クリックだけでは何もしない
      resetSelection();
      render();
      return;
    }

    if (state.phase === 'play') {
      var stack = state.board[x][y];
      var top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.owner === myOwner && canAct(myOwner)) {
        var targets = Engine.legalMovesForPiece(state, x, y).map(function (m) {
          return { x: m.x, y: m.y, kind: m.kind === 'capture' ? 'capture' : (m.kind === 'tsuke' ? 'tsuke' : 'move') };
        });
        selection = { mode: 'board', originX: x, originY: y, targets: targets };
      } else {
        resetSelection();
      }
      render();
    }
  }

  function onHandClick(owner, type) {
    if (owner !== myOwner || !canAct(myOwner)) return;

    if (state.phase === 'placement') {
      if (!state.suiPlaced[myOwner] && type !== 'sui') {
        UI.addLog('先に帥(すい)を配置してください');
        return;
      }
      var rows = Engine.territoryRows(myOwner);
      var targets = [];
      for (var x = 1; x <= P.BOARD_SIZE; x++) {
        rows.forEach(function (y) {
          if (state.board[x][y].length === 0) targets.push({ x: x, y: y, kind: 'arata' });
        });
      }
      selection = { mode: 'hand', handType: type, targets: targets };
      render();
      return;
    }

    if (state.phase === 'play') {
      var arataTargets = Engine.legalArataSquares(state, type).map(function (s) { return { x: s.x, y: s.y, kind: 'arata' }; });
      var turncoatTargets = [];
      if (type === 'hakaru') {
        turncoatTargets = Engine.legalTurncoatTargets(state).map(function (s) { return { x: s.x, y: s.y, kind: 'turncoat' }; });
      }
      selection = { mode: 'hand', handType: type, targets: arataTargets.concat(turncoatTargets) };
      render();
    }
  }

  function commitSelectionTo(x, y) {
    if (!selection) return;
    if (selection.mode === 'board') {
      var r = Engine.move(state, selection.originX, selection.originY, x, y);
      if (r.ok) {
        Net.send({ t: 'ACTION', kind: 'move', fromX: selection.originX, fromY: selection.originY, toX: x, toY: y });
        logMove(selection.originX, selection.originY, x, y);
      }
    } else if (selection.mode === 'hand') {
      if (state.phase === 'placement') {
        var rp = Engine.place(state, selection.handType, x, y);
        if (rp.ok) {
          Net.send({ t: 'ACTION', kind: 'place', pieceType: selection.handType, x: x, y: y });
          UI.addLog(((1 - state.turn === 0) ? '先手' : '後手') + 'が' + pieceLabel(selection.handType) + 'を配置');
        }
      } else {
        var targetInfo = selection.targets.find(function (t) { return t.x === x && t.y === y; });
        if (targetInfo && targetInfo.kind === 'turncoat') {
          var rt = Engine.turncoat(state, x, y);
          if (rt.ok) {
            Net.send({ t: 'ACTION', kind: 'turncoat', x: x, y: y });
            UI.addLog('謀の寝返り: ' + x + ',' + y + ' の駒が寝返った');
          }
        } else {
          var ra = Engine.arata(state, selection.handType, x, y);
          if (ra.ok) {
            Net.send({ t: 'ACTION', kind: 'arata', pieceType: selection.handType, x: x, y: y });
            UI.addLog('新: ' + pieceLabel(selection.handType) + ' を ' + x + ',' + y + ' へ');
          }
        }
      }
    }
    resetSelection();
    afterLocalAction();
  }

  function logMove(fx, fy, tx, ty) {
    UI.addLog(fx + ',' + fy + ' → ' + tx + ',' + ty);
  }

  function afterLocalAction() {
    render();
  }

  function showGameOver() {
    var els = UI.els();
    var res = state.result;
    var reasonText = {
      capture: '帥を捕獲しました',
      checkmate: '詰みです(合法手がなく、王手を回避できません)',
      no_moves: '合法な手がありません',
      resign: '投了しました',
      repetition: '同一局面が4回発生したため引き分けです',
    }[res.reason] || res.reason;

    if (res.winner === null) {
      els.resultLine.textContent = '引き分け';
    } else {
      var iWon = res.winner === myOwner;
      els.resultLine.textContent = (res.winner === 0 ? '先手' : '後手') + 'の勝ち' + (iWon ? '(あなたの勝利！)' : '(あなたの敗北)');
    }
    els.reasonLine.textContent = reasonText;
    rematchReady = [false, false];
    updateRematchStatus();
    UI.showModal('gameover-modal');
  }
})();
