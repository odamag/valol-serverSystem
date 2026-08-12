/**
 * 軍儀 (Gungi) - ゲーム状態・ルールエンジン
 *
 * pieces.js の駒定義/移動生成の上に、対局の状態管理(配置フェーズ・本戦フェーズ)、
 * ツケ/新(アラタ)/謀の寝返り、王手・詰み判定、千日手判定を実装する。
 * ブラウザ(window.Gungi.Engine)・Node.js(require)の両方から使えるようにしている。
 */
(function (root) {
  'use strict';

  var P = (typeof module !== 'undefined' && module.exports)
    ? require('./pieces.js')
    : root.Gungi.Pieces;

  var BOARD_SIZE = P.BOARD_SIZE;

  function territoryRows(owner) {
    return owner === 0 ? [1, 2, 3] : [7, 8, 9];
  }

  // デフォルト固定配置テンプレート(お任せ配置・お試しプレイ用)。
  // offset: 0=自陣いちばん奥の列, 1=中列, 2=敵陣にいちばん近い列
  // note.com「軍儀の考察」記事に掲載の配置例を基にした15駒編成(残り10駒は持ち駒のまま本戦へ)。
  var DEFAULT_LAYOUT = [
    { x: 4, offset: 0, type: 'chuu' }, { x: 5, offset: 0, type: 'sui' }, { x: 6, offset: 0, type: 'tai' },

    { x: 2, offset: 1, type: 'uma' }, { x: 3, offset: 1, type: 'yumi' },
    { x: 5, offset: 1, type: 'yari' }, { x: 7, offset: 1, type: 'yumi' },
    { x: 8, offset: 1, type: 'shinobi' },

    { x: 1, offset: 2, type: 'hyou' }, { x: 3, offset: 2, type: 'toride' },
    { x: 4, offset: 2, type: 'samurai' }, { x: 5, offset: 2, type: 'hyou' },
    { x: 6, offset: 2, type: 'samurai' }, { x: 7, offset: 2, type: 'toride' },
    { x: 9, offset: 2, type: 'hyou' },
  ];

  function layoutSquareFor(owner, entry) {
    var y = owner === 0 ? (1 + entry.offset) : (9 - entry.offset);
    return { x: entry.x, y: y, type: entry.type };
  }

  // 手番/宣言状態を無視して、そのプレイヤーの持ち駒を既定フォーメーションへ一括配置する。
  // 既に置かれているマスや、持ち駒が尽きた駒種はスキップする。配置後は自動で「済」を宣言する。
  function autoFillRemaining(state, owner) {
    if (state.phase !== 'placement') return { ok: false, error: 'not_placement_phase' };
    DEFAULT_LAYOUT.forEach(function (entry) {
      var sq = layoutSquareFor(owner, entry);
      if (state.board[sq.x][sq.y].length !== 0) return;
      if (!state.hands[owner][sq.type]) return;
      state.hands[owner][sq.type] -= 1;
      state.board[sq.x][sq.y].push({ owner: owner, type: sq.type });
      if (sq.type === 'sui') state.suiPlaced[owner] = true;
    });
    // テンプレートに含まれない駒(小・弓×1・砲・筒・謀など)は、あえて持ち駒に残したまま
    // 本戦フェーズへ進み、対局中の「新(アラタ)」で使えるようにする。
    // ただし帥だけは、テンプレート枠が手番進行の都合で埋まっていて置けなかった場合に備え、
    // 自陣内の空マスへ確保する(帥不在のまま配置完了になるのを防ぐ安全策)。
    if (!state.suiPlaced[owner]) {
      var rows = territoryRows(owner);
      outer:
      for (var i = 0; i < rows.length; i++) {
        for (var x = 1; x <= BOARD_SIZE; x++) {
          if (state.board[x][rows[i]].length === 0) {
            state.hands[owner].sui -= 1;
            state.board[x][rows[i]].push({ owner: owner, type: 'sui' });
            state.suiPlaced[owner] = true;
            break outer;
          }
        }
      }
    }
    state.placementPassed[owner] = true;
    advancePlacementTurn(state);
    return { ok: true };
  }

  // 両者ともデフォルト配置で即座に本戦フェーズへ進める「お試しプレイ」用ショートカット。
  function quickStartBothDefault(state) {
    autoFillRemaining(state, 0);
    autoFillRemaining(state, 1);
  }

  function deepCloneBoard(board) {
    var nb = {};
    for (var x = 1; x <= BOARD_SIZE; x++) {
      nb[x] = {};
      for (var y = 1; y <= BOARD_SIZE; y++) {
        nb[x][y] = board[x][y].map(function (p) { return { owner: p.owner, type: p.type }; });
      }
    }
    return nb;
  }

  function cloneHands(hands) {
    return [Object.assign({}, hands[0]), Object.assign({}, hands[1])];
  }

  function createInitialState() {
    return {
      board: P.createEmptyBoard(),
      hands: [P.initialHand(), P.initialHand()],
      graveyard: [[], []],
      turn: 0,
      phase: 'placement',
      placementPassed: [false, false],
      suiPlaced: [false, false],
      check: null,
      result: null,
      positionCounts: {},
      lastAction: null,
    };
  }

  function cloneState(state) {
    return {
      board: deepCloneBoard(state.board),
      hands: cloneHands(state.hands),
      graveyard: [state.graveyard[0].slice(), state.graveyard[1].slice()],
      turn: state.turn,
      phase: state.phase,
      placementPassed: state.placementPassed.slice(),
      suiPlaced: state.suiPlaced.slice(),
      check: state.check,
      result: state.result,
      positionCounts: Object.assign({}, state.positionCounts),
      lastAction: state.lastAction,
    };
  }

  function findSui(board, owner) {
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var top = P.topOf(board[x][y]);
        if (top && top.owner === owner && top.type === 'sui') return { x: x, y: y };
      }
    }
    return null;
  }

  // byOwner側の駒で (x,y) に利いている(捕獲できる)ものがあるか
  function isSquareAttacked(board, x, y, byOwner) {
    for (var bx = 1; bx <= BOARD_SIZE; bx++) {
      for (var by = 1; by <= BOARD_SIZE; by++) {
        var stack = board[bx][by];
        var top = P.topOf(stack);
        if (!top || top.owner !== byOwner) continue;
        var moves = P.genPieceMoves(board, bx, by, byOwner, top.type, stack.length);
        for (var i = 0; i < moves.length; i++) {
          if (moves[i].x === x && moves[i].y === y && moves[i].kind === 'capture') return true;
        }
      }
    }
    return false;
  }

  function isInCheck(state, owner) {
    var pos = findSui(state.board, owner);
    if (!pos) return false; // 帥が既に盤上にない(捕獲済み=対局終了しているはず)
    return isSquareAttacked(state.board, pos.x, pos.y, 1 - owner);
  }

  // ---- 生の(自玉の安全性を考慮しない)アクション適用 ----

  function rawApplyMove(state, fromX, fromY, toX, toY, moveInfo) {
    var owner = state.turn;
    var fromStack = state.board[fromX][fromY];
    var moving = fromStack.pop();
    var toStack = state.board[toX][toY];
    if (moveInfo.kind === 'capture') {
      var captured = toStack.pop();
      state.graveyard[owner].push(captured);
      toStack.push(moving);
      if (captured.type === 'sui') {
        state.result = { winner: owner, reason: 'capture' };
        state.phase = 'ended';
      }
    } else {
      // 'move' (空マス) または 'tsuke' (自駒の上)
      toStack.push(moving);
    }
    state.lastAction = { type: 'move', fromX: fromX, fromY: fromY, toX: toX, toY: toY, kind: moveInfo.kind, owner: owner };
  }

  function rawApplyArata(state, type, x, y) {
    var owner = state.turn;
    state.hands[owner][type] -= 1;
    state.board[x][y].push({ owner: owner, type: type });
    state.lastAction = { type: 'arata', pieceType: type, x: x, y: y, owner: owner };
  }

  function rawApplyTurncoat(state, x, y) {
    var owner = state.turn;
    var stack = state.board[x][y];
    var top = stack[stack.length - 1];
    var targetType = top.type;
    state.hands[owner].hakaru -= 1;
    state.hands[owner][targetType] -= 1;
    top.owner = owner; // 寝返り: 所有者だけ書き換え、段はそのまま
    state.lastAction = { type: 'turncoat', x: x, y: y, owner: owner, flippedType: targetType };
  }

  // ---- 自玉が王手にならないかを検証した上での合法アクション列挙 ----

  function wouldSelfCheck(state, applyFn) {
    var sim = cloneState(state);
    var savedTurn = sim.turn;
    applyFn(sim);
    if (sim.result && sim.result.reason === 'capture') return false; // 相手の帥を取った=王手放置は無関係
    return isInCheck(sim, savedTurn);
  }

  function legalMovesForPiece(state, x, y) {
    if (state.phase !== 'play') return [];
    var stack = state.board[x][y];
    var top = P.topOf(stack);
    if (!top || top.owner !== state.turn) return [];
    var raw = P.genPieceMoves(state.board, x, y, top.owner, top.type, stack.length);
    return raw.filter(function (m) {
      return !wouldSelfCheck(state, function (sim) {
        rawApplyMove(sim, x, y, m.x, m.y, m);
      });
    });
  }

  function legalArataSquares(state, type) {
    if (state.phase !== 'play') return [];
    var owner = state.turn;
    if (!state.hands[owner][type]) return [];
    var squares = [];
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        if (state.board[x][y].length !== 0) continue;
        var ok = !wouldSelfCheck(state, function (sim) {
          rawApplyArata(sim, type, x, y);
        });
        if (ok) squares.push({ x: x, y: y });
      }
    }
    return squares;
  }

  function legalTurncoatTargets(state) {
    if (state.phase !== 'play') return [];
    var owner = state.turn;
    if (!state.hands[owner].hakaru) return [];
    var targets = [];
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var stack = state.board[x][y];
        var top = P.topOf(stack);
        if (!top || top.owner === owner) continue;
        if (top.type === 'sui') continue; // 敵の帥は寝返らせられない
        if (!state.hands[owner][top.type]) continue;
        var ok = !wouldSelfCheck(state, function (sim) {
          rawApplyTurncoat(sim, x, y);
        });
        if (ok) targets.push({ x: x, y: y, flippedType: top.type });
      }
    }
    return targets;
  }

  function allLegalActionsExist(state) {
    if (state.phase !== 'play') return true;
    var owner = state.turn;
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var top = P.topOf(state.board[x][y]);
        if (top && top.owner === owner) {
          if (legalMovesForPiece(state, x, y).length > 0) return true;
        }
      }
    }
    var hand = state.hands[owner];
    for (var i = 0; i < P.PIECE_ORDER.length; i++) {
      var type = P.PIECE_ORDER[i];
      if (!hand[type]) continue;
      if (type === 'hakaru') {
        if (legalTurncoatTargets(state).length > 0) return true;
        // 謀は通常マスへの新もできる(1マス移動特殊駒として)ので下のチェックにも掛かる
      }
      if (legalArataSquares(state, type).length > 0) return true;
    }
    return false;
  }

  function positionHash(state) {
    var rows = [];
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var s = state.board[x][y];
        if (s.length) rows.push(x + '_' + y + ':' + s.map(function (p) { return p.owner + p.type; }).join(','));
      }
    }
    var h0 = P.PIECE_ORDER.map(function (t) { return state.hands[0][t]; }).join(',');
    var h1 = P.PIECE_ORDER.map(function (t) { return state.hands[1][t]; }).join(',');
    return rows.join('|') + '#' + h0 + '#' + h1 + '#' + state.turn;
  }

  function finalizeTurnEnd(state) {
    if (state.result) return; // 既に決着(帥を取った等)
    state.check = isInCheck(state, state.turn) ? state.turn : null;
    if (!allLegalActionsExist(state)) {
      state.result = { winner: 1 - state.turn, reason: state.check ? 'checkmate' : 'no_moves' };
      state.phase = 'ended';
      return;
    }
    if (state.phase === 'play') {
      var hash = positionHash(state);
      state.positionCounts[hash] = (state.positionCounts[hash] || 0) + 1;
      if (state.positionCounts[hash] >= 4) {
        state.result = { winner: null, reason: 'repetition' };
        state.phase = 'ended';
      }
    }
  }

  // ---- 公開API: 実際にゲームを進める操作 ----

  function place(state, type, x, y) {
    if (state.phase !== 'placement') return { ok: false, error: 'not_placement_phase' };
    var owner = state.turn;
    if (state.placementPassed[owner]) return { ok: false, error: 'already_passed' };
    if (!state.hands[owner][type]) return { ok: false, error: 'no_piece_in_hand' };
    if (!territoryRows(owner).includes(y)) return { ok: false, error: 'outside_territory' };
    if (!P.inBounds(x, y) || state.board[x][y].length !== 0) return { ok: false, error: 'square_occupied' };
    if (!state.suiPlaced[owner] && type !== 'sui') return { ok: false, error: 'must_place_sui_first' };

    state.hands[owner][type] -= 1;
    state.board[x][y].push({ owner: owner, type: type });
    if (type === 'sui') state.suiPlaced[owner] = true;
    state.lastAction = { type: 'place', pieceType: type, x: x, y: y, owner: owner };

    advancePlacementTurn(state);
    return { ok: true };
  }

  function passPlacement(state) {
    if (state.phase !== 'placement') return { ok: false, error: 'not_placement_phase' };
    var owner = state.turn;
    if (!state.suiPlaced[owner]) return { ok: false, error: 'sui_not_placed' };
    state.placementPassed[owner] = true;
    state.lastAction = { type: 'pass_placement', owner: owner };
    advancePlacementTurn(state);
    return { ok: true };
  }

  function advancePlacementTurn(state) {
    if (state.placementPassed[0] && state.placementPassed[1]) {
      state.phase = 'play';
      state.turn = 0;
      finalizeTurnEnd(state);
      return;
    }
    var next = 1 - state.turn;
    if (!state.placementPassed[next]) {
      state.turn = next;
    } // else: 相手は配置済み宣言済みなので自分の番のまま継続
  }

  function move(state, fromX, fromY, toX, toY) {
    if (state.phase !== 'play') return { ok: false, error: 'not_play_phase' };
    var legal = legalMovesForPiece(state, fromX, fromY);
    var chosen = legal.find(function (m) { return m.x === toX && m.y === toY; });
    if (!chosen) return { ok: false, error: 'illegal_move' };
    var mover = state.turn;
    rawApplyMove(state, fromX, fromY, toX, toY, chosen);
    if (!state.result) {
      state.turn = 1 - mover;
      finalizeTurnEnd(state);
    }
    return { ok: true };
  }

  function arata(state, type, x, y) {
    if (state.phase !== 'play') return { ok: false, error: 'not_play_phase' };
    var legalSquares = legalArataSquares(state, type);
    if (!legalSquares.some(function (s) { return s.x === x && s.y === y; })) {
      return { ok: false, error: 'illegal_drop' };
    }
    var owner = state.turn;
    rawApplyArata(state, type, x, y);
    state.turn = 1 - owner;
    finalizeTurnEnd(state);
    return { ok: true };
  }

  function turncoat(state, x, y) {
    if (state.phase !== 'play') return { ok: false, error: 'not_play_phase' };
    var legalTargets = legalTurncoatTargets(state);
    if (!legalTargets.some(function (t) { return t.x === x && t.y === y; })) {
      return { ok: false, error: 'illegal_turncoat' };
    }
    var owner = state.turn;
    rawApplyTurncoat(state, x, y);
    state.turn = 1 - owner;
    finalizeTurnEnd(state);
    return { ok: true };
  }

  function resign(state, owner) {
    if (state.result) return { ok: false, error: 'already_ended' };
    state.result = { winner: 1 - owner, reason: 'resign' };
    state.phase = 'ended';
    state.lastAction = { type: 'resign', owner: owner };
    return { ok: true };
  }

  var api = {
    createInitialState: createInitialState,
    cloneState: cloneState,
    territoryRows: territoryRows,
    findSui: findSui,
    isInCheck: isInCheck,
    isSquareAttacked: isSquareAttacked,
    legalMovesForPiece: legalMovesForPiece,
    legalArataSquares: legalArataSquares,
    legalTurncoatTargets: legalTurncoatTargets,
    place: place,
    passPlacement: passPlacement,
    autoFillRemaining: autoFillRemaining,
    quickStartBothDefault: quickStartBothDefault,
    move: move,
    arata: arata,
    turncoat: turncoat,
    resign: resign,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Gungi = root.Gungi || {};
    root.Gungi.Engine = api;
  }
})(typeof window !== 'undefined' ? window : this);
