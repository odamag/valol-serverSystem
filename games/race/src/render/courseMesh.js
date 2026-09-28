/**
 * コースの静止メッシュ(設計書 12節):芝・道路・縁石・壁・スタート/ゴールライン・グリッド線・
 * ブーストパッド・アイテムボックス。`three` を直接使うのでブラウザ専用。
 */
import * as THREE from 'three';
import { COURSE_DATA } from '../core/courseData.js';

/** n x n のチェッカー柄の CanvasTexture(スタート/ゴールラインに使う) */
function makeCheckerTexture(cellPx, colorA, colorB) {
  const size = cellPx * 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = colorA;
  g.fillRect(0, 0, size, size);
  g.fillStyle = colorB;
  g.fillRect(0, 0, cellPx, cellPx);
  g.fillRect(cellPx, cellPx, cellPx, cellPx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 矢印(ブーストパッド用)の CanvasTexture */
function makeArrowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#f97316';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(32, 8);
  g.lineTo(56, 56);
  g.lineTo(40, 56);
  g.lineTo(40, 120);
  g.lineTo(24, 120);
  g.lineTo(24, 56);
  g.lineTo(8, 56);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 「?」の CanvasTexture(アイテムボックス用) */
function makeQuestionTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff';
  g.font = 'bold 48px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('?', 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 中心線に沿った帯ジオメトリ(平面:y は一定)。lateral(innerLateral〜outerLateral)の帯を1周分作る。
 * `checker` を渡すと s に沿って頂点色で交互に塗る(縁石用)。
 */
function buildFlatRibbon(course, innerLateral, outerLateral, checkerLength) {
  const n = course.n;
  const positions = [];
  const colors = checkerLength ? [] : null;
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const s = course.ss[idx];
    const pIn = course.toWorld(s, innerLateral);
    const pOut = course.toWorld(s, outerLateral);
    positions.push(pIn.x, 0, pIn.z, pOut.x, 0, pOut.z);
    if (colors) {
      const seg = Math.floor(s / checkerLength) % 2;
      const v = seg === 0 ? 1 : 0.1;
      colors.push(v, v, v, v, v, v);
    }
  }
  const indices = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/** 壁のジオメトリ(縦の帯:lateral 固定、y=0〜height) */
function buildWallGeometry(course, lateral, height) {
  const n = course.n;
  const positions = [];
  for (let i = 0; i <= n; i++) {
    const idx = i % n;
    const s = course.ss[idx];
    const p = course.toWorld(s, lateral);
    positions.push(p.x, 0, p.z, p.x, height, p.z);
  }
  const indices = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

/** コース全体を覆う芝の平面 */
function buildGrassMesh(course) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < course.n; i++) {
    minX = Math.min(minX, course.xs[i]);
    maxX = Math.max(maxX, course.xs[i]);
    minZ = Math.min(minZ, course.zs[i]);
    maxZ = Math.max(maxZ, course.zs[i]);
  }
  const margin = 40;
  const w = maxX - minX + margin * 2;
  const d = maxZ - minZ + margin * 2;
  const geom = new THREE.PlaneGeometry(w, d);
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 1 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((minX + maxX) / 2, -0.02, (minZ + maxZ) / 2);
  return mesh;
}

/**
 * 平らな矩形を、局所座標の +X = 左方向、+Z = 進行方向(トラック接線)、+Y = 上 になるように作る。
 * `object.rotation.y = yaw` で向けるカート等と同じ規約(設計書 2.1節)。
 * `PlaneGeometry` + `rotateX` は回す向きによって法線が下を向いてしまう(裏面カリングで消える)ので、
 * 頂点を直接組んで上向き法線にする。
 */
function buildOrientedPlane(widthLateral, lengthAlongTrack, texture) {
  const hw = widthLateral / 2;
  const hl = lengthAlongTrack / 2;
  const positions = new Float32Array([
    -hw, 0, -hl,
    hw, 0, -hl,
    hw, 0, hl,
    -hw, 0, hl,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const indices = [0, 2, 1, 0, 3, 2]; // +Y 法線になる向き
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  const mat = texture
    ? new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  return new THREE.Mesh(geom, mat);
}

/**
 * `course`・`cfg` からコースの静的+動的(ボックスの明滅・回転)メッシュ一式を作る。
 * @param {object} course buildCourse() の戻り値
 * @param {object} cfg makeConfig() の戻り値
 * @returns {{ group: THREE.Group, update(view: object, dt: number): void, dispose(): void }}
 */
export function buildCourseMesh(course, cfg) {
  const group = new THREE.Group();
  const disposables = [];
  const track = (obj) => {
    disposables.push(obj);
    return obj;
  };

  const road = COURSE_DATA.roadHalfWidth;
  const wall = COURSE_DATA.wallLateral;

  // 芝
  const grass = buildGrassMesh(course);
  group.add(grass);
  track(grass.geometry);
  track(grass.material);

  // 道路
  {
    const geom = buildFlatRibbon(course, -road, road);
    const mat = new THREE.MeshStandardMaterial({ color: 0x555a60, roughness: 1 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.y = 0;
    group.add(mesh);
    track(geom);
    track(mat);
  }

  // 縁石(道路の両端、幅0.6m、赤白の市松)
  {
    const curbWidth = 0.6;
    for (const side of [1, -1]) {
      const outer = side * road;
      const inner = side * (road - curbWidth);
      const geom = buildFlatRibbon(course, Math.min(inner, outer), Math.max(inner, outer), 4);
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
      // 頂点色は 0(赤寄り)/1(白)の輝度なので、赤白に見えるよう color を掛け合わせる
      mat.color = new THREE.Color(0xff3b3b);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.y = 0.005;
      group.add(mesh);
      track(geom);
      track(mat);
    }
  }

  // 壁(両側、高さ1.2m)
  for (const side of [1, -1]) {
    const geom = buildWallGeometry(course, side * wall, 1.2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, side: THREE.DoubleSide, roughness: 0.8 });
    const mesh = new THREE.Mesh(geom, mat);
    group.add(mesh);
    track(geom);
    track(mat);
  }

  // スタート/ゴールライン(s=0 に市松、道路の全幅)
  {
    const tex = makeCheckerTexture(16, '#ffffff', '#111111');
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, Math.max(2, Math.round(road / 1.5)));
    track(tex);
    const mesh = buildOrientedPlane(road * 2, 2, tex);
    track(mesh.geometry);
    track(mesh.material);
    const p = course.pointAt(0);
    const yaw = Math.atan2(p.tx, p.tz);
    mesh.position.set(p.x, 0.01, p.z);
    mesh.rotation.y = yaw;
    group.add(mesh);
  }

  // グリッドの白線(8か所)
  for (let i = 0; i < 8; i++) {
    const pose = course.gridPose(i);
    const mesh = buildOrientedPlane(2.6, 0.15);
    mesh.material.color = new THREE.Color(0xffffff);
    track(mesh.geometry);
    track(mesh.material);
    mesh.position.set(pose.x, 0.012, pose.z);
    mesh.rotation.y = pose.yaw;
    group.add(mesh);
  }

  // ブーストパッド
  const arrowTex = makeArrowTexture();
  track(arrowTex);
  for (const pad of course.boostPads) {
    const mesh = buildOrientedPlane(3, 5, arrowTex);
    track(mesh.geometry);
    track(mesh.material);
    const p = course.pointAt(pad.s);
    const yaw = Math.atan2(p.tx, p.tz);
    const pos = course.toWorld(pad.s, pad.lateral);
    mesh.position.set(pos.x, 0.02, pos.z);
    mesh.rotation.y = yaw;
    group.add(mesh);
  }

  // アイテムボックス(回転・上下の揺れ・有効/無効の表示切り替え)
  const questionTex = makeQuestionTexture();
  track(questionTex);
  const boxEntries = course.itemBoxes.map((box) => {
    const boxGeom = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardMaterial({
      color: 0x66ccff,
      transparent: true,
      opacity: 0.55,
      roughness: 0.2,
      metalness: 0.1,
    });
    const mesh = new THREE.Mesh(boxGeom, boxMat);
    track(boxGeom);
    track(boxMat);
    const pos = course.toWorld(box.s, box.lateral);
    mesh.position.set(pos.x, 0.9, pos.z);

    const spriteMat = new THREE.SpriteMaterial({ map: questionTex, transparent: true });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(1, 1, 1);
    sprite.position.y = 0.05;
    track(spriteMat);
    mesh.add(sprite);

    group.add(mesh);
    return { id: box.id, mesh, phase: Math.random() * Math.PI * 2 };
  });

  let boxAnimT = 0;
  /**
   * @param {object} view RenderView(boxes だけ使う)
   * @param {number} dt
   */
  function update(view, dt) {
    boxAnimT += dt;
    const boxes = view && view.boxes;
    for (const entry of boxEntries) {
      const active = boxes ? boxes[entry.id] !== false : true;
      entry.mesh.visible = active;
      if (active) {
        entry.mesh.rotation.y = boxAnimT * 1.2 + entry.phase;
        entry.mesh.position.y = 0.9 + Math.sin(boxAnimT * 2 + entry.phase) * 0.15;
      }
    }
  }

  function dispose() {
    for (const obj of disposables) obj.dispose();
    group.clear();
  }

  return { group, update, dispose };
}
