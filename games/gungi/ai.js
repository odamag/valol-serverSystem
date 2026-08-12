/**
 * 軍儀 (Gungi) - 1人プレイ用AI
 *
 * engine.js が公開する合法手列挙(自玉の安全性チェック込み)をそのまま利用し、
 * 静的評価関数による貪欲法(1手読み)でAIの一手を選ぶ。
 * 盤面のスタック構造上、全アクション(移動・新・寝返り)の組み合わせは
 * 対局中盤で数百に達することがあるため、深い探索(2手読み以上)は行わず、
 * 「強い」難易度では簡易的な"駒がタダ取りされないか"のチェックのみ追加する。
 */
(function (root) {
  'use strict';

  var Engine = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : root.Gungi.Engine;
  var P = (typeof module !== 'undefined' && module.exports)
    ? require('./pieces.js')
    : root.Gungi.Pieces;

  var BOARD_SIZE = P.BOARD_SIZE;

  // 駒の基礎価値(射程・特殊能力のおおよその強さを反映した目安)
  var PIECE_VALUE = {
    sui: 1000, hakaru: 6, tai: 9, chuu: 9, shou: 4, toride: 3, hyou: 2,
    samurai: 4, yari: 4, shinobi: 5, uma: 5, yumi: 5, ozutsu: 7, tsutsu: 7,
  };

  function collectAllActions(state) {
    var owner = state.turn;
    var actions = [];
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var stack = state.board[x][y];
        var top = stack.length ? stack[stack.length - 1] : null;
        if (top && top.owner === owner) {
          Engine.legalMovesForPiece(state, x, y).forEach(function (m) {
            actions.push({ kind: 'move', fromX: x, fromY: y, toX: m.x, toY: m.y, moveKind: m.kind });
          });
        }
      }
    }
    P.PIECE_ORDER.forEach(function (type) {
      if (!state.hands[owner][type]) return;
      Engine.legalArataSquares(state, type).forEach(function (s) {
        actions.push({ kind: 'arata', pieceType: type, x: s.x, y: s.y });
      });
      if (type === 'hakaru') {
        Engine.legalTurncoatTargets(state).forEach(function (t) {
          actions.push({ kind: 'turncoat', x: t.x, y: t.y });
        });
      }
    });
    return actions;
  }

  function evaluate(state, forOwner) {
    var oppOwner = 1 - forOwner;
    var score = 0;
    for (var x = 1; x <= BOARD_SIZE; x++) {
      for (var y = 1; y <= BOARD_SIZE; y++) {
        var stack = state.board[x][y];
        for (var i = 0; i < stack.length; i++) {
          var p = stack[i];
          var v = PIECE_VALUE[p.type] * (1 + i * 0.15); // 高い段に積まれているほど僅かに加点
          score += (p.owner === forOwner ? v : -v);
        }
      }
    }
    P.PIECE_ORDER.forEach(function (type) {
      score += (state.hands[forOwner][type] || 0) * PIECE_VALUE[type] * 0.4;
      score -= (state.hands[oppOwner][type] || 0) * PIECE_VALUE[type] * 0.4;
    });
    if (state.result) {
      if (state.result.winner === forOwner) score += 5000;
      else if (state.result.winner === oppOwner) score -= 5000;
    } else {
      if (state.check === forOwner) score -= 15;
      if (state.check === oppOwner) score += 15;
    }
    return score;
  }

  function applyActionToClone(state, action) {
    var sim = Engine.cloneState(state);
    if (action.kind === 'move') Engine.move(sim, action.fromX, action.fromY, action.toX, action.toY);
    else if (action.kind === 'arata') Engine.arata(sim, action.pieceType, action.x, action.y);
    else if (action.kind === 'turncoat') Engine.turncoat(sim, action.x, action.y);
    return sim;
  }

  function destinationOf(action) {
    return action.kind === 'move' ? { x: action.toX, y: action.toY } : { x: action.x, y: action.y };
  }

  function weightedRandomPick(items, weights) {
    var total = weights.reduce(function (a, b) { return a + b; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  /**
   * state.turn 側のプレイヤーとしてAIに一手選ばせる。
   * difficulty: 'easy' | 'normal' | 'hard'
   * 戻り値: {kind:'move'|'arata'|'turncoat', ...} または合法手が無ければ null
   */
  function chooseAction(state, difficulty) {
    if (state.phase !== 'play' || state.result) return null;
    var owner = state.turn;
    var actions = collectAllActions(state);
    if (!actions.length) return null;

    if (difficulty === 'easy') {
      var weights = actions.map(function (a) {
        if (a.kind === 'move' && a.moveKind === 'capture') return 6;
        if (a.kind === 'turncoat') return 5;
        if (a.kind === 'move' && a.moveKind === 'tsuke') return 2;
        return 1;
      });
      return weightedRandomPick(actions, weights);
    }

    var scored = actions.map(function (a) {
      var sim = applyActionToClone(state, a);
      var score = evaluate(sim, owner);
      if (difficulty === 'hard' && !sim.result) {
        var dest = destinationOf(a);
        var destStack = sim.board[dest.x][dest.y];
        var destTier = destStack.length;
        // 移動直後の相手の手番想定で、置いた駒がタダ取りされそうなら減点
        if (destTier > 0 && Engine.isSquareAttacked(sim.board, dest.x, dest.y, 1 - owner)) {
          var placedType = destStack[destStack.length - 1].type;
          score -= PIECE_VALUE[placedType] * 0.7;
        }
      }
      return { action: a, score: score };
    });

    scored.sort(function (s1, s2) { return s2.score - s1.score; });

    if (difficulty === 'hard') return scored[0].action;

    // normal: 最善手付近から少しランダム性を持たせて単調さを避ける
    var top = scored.filter(function (s) { return s.score >= scored[0].score - 1.5; });
    return top[Math.floor(Math.random() * top.length)].action;
  }

  var api = {
    chooseAction: chooseAction,
    evaluate: evaluate,
    collectAllActions: collectAllActions,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Gungi = root.Gungi || {};
    root.Gungi.AI = api;
  }
})(typeof window !== 'undefined' ? window : this);
