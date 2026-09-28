/**
 * コースの構築(設計書 5.2節)。`buildCourse(data, cfg)` は閉じた centripetal Catmull-Rom
 * スプラインを自前で組んで、中心線を約1m間隔に取り直したサンプル列として持つ `Course` を返す。
 * DOM・three・乱数には触れない(設計書 2.2節)。three のスプライン実装は使わない(設計書 5.2節)。
 */

const ALPHA = 0.5; // centripetal Catmull-Rom
const SEGMENT_DIVS = 50; // 1区間の細分割数(密なサンプリング用)

/** 2点間のユークリッド距離 */
function dist(p0, p1) {
  const dx = p1[0] - p0[0];
  const dz = p1[1] - p0[1];
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Barry–Goldman 法による centripetal Catmull-Rom の1点評価。
 * p0..p3 は制御点、t0..t3 はノット値、t は [t1, t2] の範囲のパラメータ。
 */
function catmullRomPoint(p0, p1, p2, p3, t0, t1, t2, t3, t) {
  const lerp2 = (a, b, ta, tb, tt) => {
    const denom = tb - ta;
    const f = denom === 0 ? 0 : (tt - ta) / denom;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  };
  const A1 = lerp2(p0, p1, t0, t1, t);
  const A2 = lerp2(p1, p2, t1, t2, t);
  const A3 = lerp2(p2, p3, t2, t3, t);
  const B1 = lerp2(A1, A2, t0, t2, t);
  const B2 = lerp2(A2, A3, t1, t3, t);
  return lerp2(B1, B2, t1, t2, t);
}

/**
 * ウェイポイントを閉じた centripetal Catmull-Rom で細かくサンプリングし、
 * 密な点列(先頭と末尾はつながっているが末尾側で重複はさせない)と、各点までの累積距離を返す。
 */
function buildDenseSamples(waypoints) {
  const n = waypoints.length;
  const dense = []; // [[x,z], ...]
  const denseS = []; // 各 dense[i] までの累積距離
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const p0 = waypoints[(i - 1 + n) % n];
    const p1 = waypoints[i];
    const p2 = waypoints[(i + 1) % n];
    const p3 = waypoints[(i + 2) % n];

    // ノット間隔は centripetal(alpha=0.5): |Pi+1 - Pi|^alpha
    const t0 = 0;
    const t1 = t0 + dist(p0, p1) ** ALPHA;
    const t2 = t1 + dist(p1, p2) ** ALPHA;
    const t3 = t2 + dist(p2, p3) ** ALPHA;

    // 区間 [t1, t2) を SEGMENT_DIVS 分割してサンプリングする(区間の終点は次の区間の始点なので重複させない)
    for (let d = 0; d < SEGMENT_DIVS; d++) {
      const t = t1 + ((t2 - t1) * d) / SEGMENT_DIVS;
      const pt = t === t1 ? p1 : catmullRomPoint(p0, p1, p2, p3, t0, t1, t2, t3, t);
      if (dense.length > 0) {
        acc += dist(dense[dense.length - 1], pt);
      }
      dense.push(pt);
      denseS.push(acc);
    }
  }
  // 最後の点(dense[0] に戻る)までの距離を足して全長を得る
  const totalLength = acc + dist(dense[dense.length - 1], dense[0]);
  return { dense, denseS, totalLength };
}

/** 密なサンプル列から、弧長パラメータ targetS の点を線形補間で得る */
function sampleAtArcLength(dense, denseS, totalLength, targetS) {
  const m = dense.length;
  // targetS を [0, totalLength) に正規化
  let s = targetS % totalLength;
  if (s < 0) s += totalLength;

  // denseS は単調増加。二分探索で s 以下の最後の index を探す
  let lo = 0;
  let hi = m - 1;
  if (s <= denseS[0]) {
    lo = 0;
  } else if (s >= denseS[m - 1]) {
    lo = m - 1;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (denseS[mid] <= s) lo = mid;
      else hi = mid;
    }
  }
  const i0 = lo;
  const i1 = (lo + 1) % m;
  const s0 = denseS[i0];
  const s1 = i1 === 0 ? totalLength : denseS[i1];
  const segLen = s1 - s0;
  const f = segLen > 1e-9 ? (s - s0) / segLen : 0;
  const p0 = dense[i0];
  const p1 = dense[i1];
  return [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
}

/**
 * `data`(courseData.js の COURSE_DATA)と `cfg`(RaceConfig)から `Course` を作る。
 * @param {typeof import('./courseData.js').COURSE_DATA} data
 * @param {object} cfg
 * @returns {Course}
 */
export function buildCourse(data, cfg) {
  const { dense, denseS, totalLength } = buildDenseSamples(data.waypoints);

  // 中心線を約1m間隔に取り直す。length/n がちょうど1mに近くなるように n を length の丸めで決める。
  const n = Math.max(3, Math.round(totalLength));
  const step = totalLength / n;

  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const ss = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = i * step;
    const [x, z] = sampleAtArcLength(dense, denseS, totalLength, s);
    xs[i] = x;
    zs[i] = z;
    ss[i] = s;
  }

  // 接線は中心差分(前後の再サンプル点から)。閉ループなので端も自然につながる。
  const txs = new Float64Array(n);
  const tzs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const iPrev = (i - 1 + n) % n;
    const iNext = (i + 1) % n;
    let dx = xs[iNext] - xs[iPrev];
    let dz = zs[iNext] - zs[iPrev];
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    txs[i] = dx / len;
    tzs[i] = dz / len;
  }

  const length = totalLength;
  const roadHalfWidth = data.roadHalfWidth;
  const wallLateral = data.wallLateral;

  /** s を [0, length) に正規化する */
  function normalizeS(s) {
    let r = s % length;
    if (r < 0) r += length;
    return r;
  }

  /** @returns {{x:number, z:number, tx:number, tz:number}} */
  function pointAt(s) {
    const ns = normalizeS(s);
    const idx = ns / step;
    const i0 = Math.floor(idx) % n;
    const i1 = (i0 + 1) % n;
    const frac = idx - Math.floor(idx);
    const x = xs[i0] + (xs[i1] - xs[i0]) * frac;
    const z = zs[i0] + (zs[i1] - zs[i0]) * frac;
    let tx = txs[i0] + (txs[i1] - txs[i0]) * frac;
    let tz = tzs[i0] + (tzs[i1] - tzs[i0]) * frac;
    const tlen = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tlen;
    tz /= tlen;
    return { x, z, tx, tz };
  }

  /** 中心線 + lateral * 左方向ベクトル(左 = (tz, -tx))(設計書 5.2節) */
  function toWorld(s, lateral) {
    const p = pointAt(s);
    const leftX = p.tz;
    const leftZ = -p.tx;
    return { x: p.x + lateral * leftX, z: p.z + lateral * leftZ };
  }

  /**
   * 最も近い線分に垂線を下ろして s と lateral を求める。`hintIndex` があればその前後±40サンプルだけを探す。
   * @returns {{s:number, lateral:number, index:number, tx:number, tz:number}}
   */
  function project(x, z, hintIndex) {
    let bestD2 = Infinity;
    let bestI = 0;
    let bestT = 0;
    let bestTx = 1;
    let bestTz = 0;

    const scan = (i) => {
      const i1 = (i + 1) % n;
      const px = xs[i];
      const pz = zs[i];
      const qx = xs[i1];
      const qz = zs[i1];
      const segDx = qx - px;
      const segDz = qz - pz;
      const segLen2 = segDx * segDx + segDz * segDz || 1e-12;
      let t = ((x - px) * segDx + (z - pz) * segDz) / segLen2;
      if (t < 0) t = 0;
      if (t > 1) t = 1;
      const projX = px + segDx * t;
      const projZ = pz + segDz * t;
      const dx = x - projX;
      const dz = z - projZ;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestI = i;
        bestT = t;
        const segLen = Math.sqrt(segLen2) || 1;
        bestTx = segDx / segLen;
        bestTz = segDz / segLen;
      }
    };

    if (hintIndex === undefined || hintIndex === null || Number.isNaN(hintIndex)) {
      for (let i = 0; i < n; i++) scan(i);
    } else {
      const start = ((hintIndex % n) + n) % n;
      for (let d = -40; d <= 40; d++) {
        const i = ((start + d) % n + n) % n;
        scan(i);
      }
    }

    const s0 = ss[bestI];
    let s = s0 + bestT * step;
    s = normalizeS(s);

    const projX = xs[bestI] + (xs[(bestI + 1) % n] - xs[bestI]) * bestT;
    const projZ = zs[bestI] + (zs[(bestI + 1) % n] - zs[bestI]) * bestT;
    const leftX = bestTz;
    const leftZ = -bestTx;
    const lateral = (x - projX) * leftX + (z - projZ) * leftZ;

    return { s, lateral, index: bestI, tx: bestTx, tz: bestTz };
  }

  /** @returns {'road'|'grass'|'wall'} */
  function surfaceAt(lateral) {
    const a = Math.abs(lateral);
    if (a <= roadHalfWidth) return 'road';
    if (a < wallLateral) return 'grass';
    return 'wall';
  }

  // チェックポイント:index 0 はスタート/ゴールライン(s = 0)。s_k = k * L / N(設計書 5.2節)
  const N = data.checkpointCount;
  const checkpoints = [];
  for (let k = 0; k < N; k++) {
    const s = (k * length) / N;
    const idx = Math.round(s / step) % n;
    checkpoints.push({ index: idx, s });
  }

  // ブーストパッド
  const boostPads = data.boostPads.map((pad, i) => ({
    id: i,
    s: pad.f * length,
    lateral: pad.lateral,
  }));

  // アイテムボックス:id = row * 5 + col(設計書 5.2節)
  const itemBoxes = [];
  data.itemBoxRows.forEach((rowData, row) => {
    rowData.laterals.forEach((lateral, col) => {
      itemBoxes.push({ id: row * 5 + col, row, s: rowData.f * length, lateral });
    });
  });

  // グリッド位置(設計書 5.2節):row = floor(i/2)、col = i%2。
  // s = frontS - row*rowGap - col*staggerS、lateral = col==0 ? +columnLateral : -columnLateral
  const gridCfg = data.grid;
  function gridPose(gridIndex) {
    const row = Math.floor(gridIndex / 2);
    const col = gridIndex % 2;
    const s = gridCfg.frontS - row * gridCfg.rowGap - col * gridCfg.staggerS;
    const lateral = col === 0 ? gridCfg.columnLateral : -gridCfg.columnLateral;
    const p = pointAt(s);
    const world = toWorld(s, lateral);
    const yaw = Math.atan2(p.tx, p.tz);
    return { x: world.x, z: world.z, yaw };
  }

  return {
    length,
    n,
    roadHalfWidth,
    wallLateral,
    xs,
    zs,
    ss,
    txs,
    tzs,
    pointAt,
    toWorld,
    project,
    surfaceAt,
    checkpoints,
    boostPads,
    itemBoxes,
    gridPose,
  };
}
