/**
 * 軍儀 (Gungi) - 駒定義 & 移動生成エンジン
 *
 * この実装はHUNTER×HUNTER作中の架空のゲーム「軍儀」を、公式に断片的に公開されている
 * 情報(コミックス付録・公式ボードゲーム版の駒の動き解説記事など)を参考にファンが再構成した
 * 非公式ルールです。原作で全ての細則が明かされているわけではないため、遊びやすさを優先して
 * 一部のマス数・方向は独自に補完しています(README/ヘルプ参照)。
 *
 * 盤面: 9x9、各マスに最大3段まで駒を積める(ツケ)。
 * 座標系: x=1..9 (列), y=1..9 (行)。
 *   先手(Player 0 / 黒)の自陣は y=1..3、後手(Player 1 / 白)の自陣は y=7..9。
 *   「前方(F)」は各プレイヤーから見て敵陣方向。
 */
(function (root) {
  'use strict';

  var BOARD_SIZE = 9;
  var MAX_TIER = 3;

  // ローカル座標系(前方=+y)での方向ベクトル
  var DIR_VECTORS = {
    F: [0, 1], B: [0, -1], L: [-1, 0], R: [1, 0],
    FL: [-1, 1], FR: [1, 1], BL: [-1, -1], BR: [1, -1],
  };

  // player 0(先手)は前方=+y方向のまま、player 1(後手)は180度回転(前方=-y)
  function worldVector(dirKey, owner) {
    var v = DIR_VECTORS[dirKey];
    if (owner === 0) return v;
    return [-v[0], -v[1]];
  }

  function inBounds(x, y) {
    return x >= 1 && x <= BOARD_SIZE && y >= 1 && y <= BOARD_SIZE;
  }

  // range(dirKey, tier) を返すヘルパを各駒定義から生成する
  function scaledAll(baseDirs) {
    // 全方向が tier とともに同じ値だけ伸びる (rangeAtTier1 + (tier-1))
    return function (dirKey, tier) {
      var base = baseDirs[dirKey];
      if (base === undefined) return 0;
      return base + (tier - 1);
    };
  }

  function fixedDirs(baseDirs) {
    // tier に関わらず一定
    return function (dirKey) {
      var base = baseDirs[dirKey];
      return base === undefined ? 0 : base;
    };
  }

  /**
   * 駒種定義
   * kind:
   *  - 'slider'  : 方向ごとの射程だけ、自駒/相手駒に当たるまで直進(スライド)する通常駒
   *  - 'rider'   : 直交/斜めのどちらかが無制限、もう片方が段数依存 (大・中専用)
   *  - 'jumper'  : 自分の段以下の駒(敵味方問わず)を飛び越えられる特殊駒(弓・砲・筒)
   * special:
   *  - 'marshal' : 帥。取られたら負け。
   *  - 'turncoat': 謀。新(アラタ)で敵駒の上に「ツケ」する形で寝返りさせられる。
   */
  var PIECES = {
    sui: {
      key: 'sui', name: '帥', kana: 'すい', count: 1, kind: 'slider',
      special: 'marshal',
      rangeFn: scaledAll({ F: 1, B: 1, L: 1, R: 1, FL: 1, FR: 1, BL: 1, BR: 1 }),
      dirs: ['F', 'B', 'L', 'R', 'FL', 'FR', 'BL', 'BR'],
    },
    hakaru: {
      key: 'hakaru', name: '謀', kana: 'はかる', count: 1, kind: 'slider',
      special: 'turncoat',
      rangeFn: scaledAll({ F: 1, B: 1, L: 1, R: 1, FL: 1, FR: 1, BL: 1, BR: 1 }),
      dirs: ['F', 'B', 'L', 'R', 'FL', 'FR', 'BL', 'BR'],
    },
    tai: {
      key: 'tai', name: '大', kana: 'たいしょう', count: 1, kind: 'rider',
      straightUnlimited: true, // タテヨコ無制限
      diagFn: scaledAll({ FL: 1, FR: 1, BL: 1, BR: 1 }),
      straightDirs: ['F', 'B', 'L', 'R'],
      diagDirs: ['FL', 'FR', 'BL', 'BR'],
    },
    chuu: {
      key: 'chuu', name: '中', kana: 'ちゅうじょう', count: 1, kind: 'rider',
      diagUnlimited: true, // ナナメ無制限
      straightFn: scaledAll({ F: 1, B: 1, L: 1, R: 1 }),
      straightDirs: ['F', 'B', 'L', 'R'],
      diagDirs: ['FL', 'FR', 'BL', 'BR'],
    },
    shou: {
      key: 'shou', name: '小', kana: 'しょうしょう', count: 2, kind: 'slider',
      rangeFn: scaledAll({ F: 1, FL: 1, FR: 1, L: 1, R: 1, B: 1 }),
      dirs: ['F', 'FL', 'FR', 'L', 'R', 'B'], // 金将型(斜め後ろ無し)
    },
    toride: {
      key: 'toride', name: '砦', kana: 'とりで', count: 2, kind: 'slider',
      rangeFn: scaledAll({ F: 1, L: 1, R: 1, BL: 1, BR: 1 }), // 斜め前・真後ろ無し
      dirs: ['F', 'L', 'R', 'BL', 'BR'],
    },
    hyou: {
      key: 'hyou', name: '兵', kana: 'ひょう', count: 4, kind: 'slider',
      rangeFn: scaledAll({ F: 1, B: 1 }),
      dirs: ['F', 'B'],
    },
    samurai: {
      key: 'samurai', name: '侍', kana: 'さむらい', count: 2, kind: 'slider',
      rangeFn: scaledAll({ FL: 1, FR: 1, B: 1 }),
      dirs: ['FL', 'FR', 'B'],
    },
    yari: {
      key: 'yari', name: '槍', kana: 'やり', count: 3, kind: 'slider',
      rangeFn: scaledAll({ F: 2, B: 1, FL: 1, FR: 1 }),
      dirs: ['F', 'B', 'FL', 'FR'],
    },
    shinobi: {
      key: 'shinobi', name: '忍', kana: 'しのび', count: 2, kind: 'slider',
      rangeFn: scaledAll({ FL: 2, FR: 2, BL: 2, BR: 2 }),
      dirs: ['FL', 'FR', 'BL', 'BR'],
    },
    uma: {
      key: 'uma', name: '馬', kana: 'うま', count: 2, kind: 'slider',
      rangeFn: scaledAll({ F: 2, B: 2, L: 1, R: 1 }),
      dirs: ['F', 'B', 'L', 'R'],
    },
    yumi: {
      key: 'yumi', name: '弓', kana: 'ゆみ', count: 2, kind: 'jumper',
      rangeFn: scaledAll({ F: 3, B: 3, L: 3, R: 3 }),
      dirs: ['F', 'B', 'L', 'R'],
    },
    ozutsu: {
      key: 'ozutsu', name: '砲', kana: 'おおづつ', count: 1, kind: 'jumper',
      rangeFn: fixedDirs({ F: 99, B: 99, L: 99, R: 99 }),
      dirs: ['F', 'B', 'L', 'R'],
    },
    tsutsu: {
      key: 'tsutsu', name: '筒', kana: 'つつ', count: 1, kind: 'jumper',
      rangeFn: fixedDirs({ FL: 99, FR: 99, BL: 99, BR: 99 }),
      dirs: ['FL', 'FR', 'BL', 'BR'],
    },
  };

  var PIECE_ORDER = ['sui', 'hakaru', 'tai', 'chuu', 'shou', 'toride', 'hyou',
    'samurai', 'yari', 'shinobi', 'uma', 'yumi', 'ozutsu', 'tsutsu'];

  var NORMAL_PIECES = ['sui', 'tai', 'chuu', 'shou', 'toride', 'hyou', 'samurai', 'yari', 'shinobi', 'uma'];
  var SPECIAL_PIECES = ['hakaru', 'yumi', 'ozutsu', 'tsutsu'];

  function initialHand() {
    var hand = {};
    PIECE_ORDER.forEach(function (k) { hand[k] = PIECES[k].count; });
    return hand;
  }

  /**
   * board: 9x9 の2次元配列。board[x][y] = [{owner, type}, ...] (下から上へ, 最大3)
   * 空の盤を生成する
   */
  function createEmptyBoard() {
    var board = {};
    for (var x = 1; x <= BOARD_SIZE; x++) {
      board[x] = {};
      for (var y = 1; y <= BOARD_SIZE; y++) {
        board[x][y] = [];
      }
    }
    return board;
  }

  function stackAt(board, x, y) {
    if (!inBounds(x, y)) return null;
    return board[x][y];
  }

  function topOf(stack) {
    return stack.length ? stack[stack.length - 1] : null;
  }

  /**
   * 1マス分のスライド/ジャンプ移動候補を生成する。
   * 戻り値: [{x, y, kind: 'move'|'tsuke'|'capture', capturedTier}]
   */
  function genDirMoves(board, x, y, tier, owner, dirKey, range, isJumper) {
    var out = [];
    var v = worldVector(dirKey, owner);
    for (var i = 1; i <= range; i++) {
      var nx = x + v[0] * i;
      var ny = y + v[1] * i;
      if (!inBounds(nx, ny)) break;
      var stack = board[nx][ny];
      if (stack.length === 0) {
        out.push({ x: nx, y: ny, kind: 'move' });
        continue; // 空マスは通過可能(遠方まで見る)
      }
      var top = stack[stack.length - 1];
      var obstHeight = stack.length; // 現在そのマスに積まれている段数(=次に置けるならその段)
      if (top.owner === owner) {
        if (!isJumper) {
          if (stack.length < MAX_TIER) {
            out.push({ x: nx, y: ny, kind: 'tsuke', resultTier: stack.length + 1 });
          }
          break; // 自駒に当たったらそこで止まる
        } else {
          if (obstHeight <= tier) {
            continue; // 自分の段以下の自駒は飛び越えて先へ
          } else {
            break; // 自分より高い自駒には遮られる
          }
        }
      } else {
        // 敵駒
        var canCapture = obstHeight <= tier; // 自分より高い段の相手駒は取れない
        if (!isJumper) {
          if (canCapture) {
            out.push({ x: nx, y: ny, kind: 'capture', capturedTier: stack.length });
          }
          break; // 敵駒に当たったら(取れても取れなくても)そこで止まる
        } else {
          if (canCapture) {
            out.push({ x: nx, y: ny, kind: 'capture', capturedTier: stack.length });
            continue; // 自分の段以下の敵駒は飛び越えてさらに先も狙える
          } else {
            break; // 自分より高い敵駒には遮られ、それ以上飛べない
          }
        }
      }
    }
    return out;
  }

  /**
   * 指定位置にある駒(owner, type, tier)が指せる移動先を全て返す。
   * 自分の帥が結果的に王手されるかどうかのチェックはここでは行わない(呼び出し側で filter する)。
   */
  function genPieceMoves(board, x, y, owner, type, tier) {
    var def = PIECES[type];
    if (!def) return [];
    var moves = [];

    if (def.kind === 'slider') {
      def.dirs.forEach(function (dirKey) {
        var range = def.rangeFn(dirKey, tier);
        if (!range) return;
        moves = moves.concat(genDirMoves(board, x, y, tier, owner, dirKey, range, false));
      });
    } else if (def.kind === 'jumper') {
      def.dirs.forEach(function (dirKey) {
        var range = def.rangeFn(dirKey, tier);
        if (!range) return;
        moves = moves.concat(genDirMoves(board, x, y, tier, owner, dirKey, range, true));
      });
    } else if (def.kind === 'rider') {
      var straightDirs = def.straightDirs;
      var diagDirs = def.diagDirs;
      straightDirs.forEach(function (dirKey) {
        var range = def.straightUnlimited ? BOARD_SIZE : def.straightFn(dirKey, tier);
        if (!range) return;
        moves = moves.concat(genDirMoves(board, x, y, tier, owner, dirKey, range, false));
      });
      diagDirs.forEach(function (dirKey) {
        var range = def.diagUnlimited ? BOARD_SIZE : def.diagFn(dirKey, tier);
        if (!range) return;
        moves = moves.concat(genDirMoves(board, x, y, tier, owner, dirKey, range, false));
      });
    }
    return moves;
  }

  var api = {
    BOARD_SIZE: BOARD_SIZE,
    MAX_TIER: MAX_TIER,
    PIECES: PIECES,
    PIECE_ORDER: PIECE_ORDER,
    NORMAL_PIECES: NORMAL_PIECES,
    SPECIAL_PIECES: SPECIAL_PIECES,
    inBounds: inBounds,
    createEmptyBoard: createEmptyBoard,
    stackAt: stackAt,
    topOf: topOf,
    initialHand: initialHand,
    genPieceMoves: genPieceMoves,
    worldVector: worldVector,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.Gungi = root.Gungi || {};
    root.Gungi.Pieces = api;
  }
})(typeof window !== 'undefined' ? window : this);
