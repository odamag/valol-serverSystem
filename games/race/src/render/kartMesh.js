/**
 * カートのメッシュ(設計書 12節)。`view.self` / `view.others` の各エントリ(slot ごと)に対応する
 * カートを作って使い回す。ブラウザ専用(`three` を直接使う)。
 */
import * as THREE from 'three';

/** 名前表示用の CanvasTexture(Sprite に貼る) */
function makeNameTexture(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.font = 'bold 40px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.fillStyle = '#ffffff';
  g.strokeText(name, canvas.width / 2, canvas.height / 2);
  g.fillText(name, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 1台ぶんのカートの Object3D 一式を作る。
 * 外側の `group`(位置・yaw)の中に、`bodyGroup`(spinVisual だけ回す)を入れる(設計書 12節)。
 */
function createKart(color, name, showName) {
  const group = new THREE.Group();
  const bodyGroup = new THREE.Group();
  group.add(bodyGroup);

  const disposables = [];
  const track = (obj) => {
    disposables.push(obj);
    return obj;
  };

  const bodyMat = track(new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, transparent: true, opacity: 1 }));
  const bodyGeom = track(new THREE.BoxGeometry(1.6, 0.6, 2.4));
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.4;
  bodyGroup.add(body);

  const seatMat = track(new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, transparent: true, opacity: 1 }));
  const seatGeom = track(new THREE.BoxGeometry(0.8, 0.4, 0.8));
  const seat = new THREE.Mesh(seatGeom, seatMat);
  seat.position.set(0, 0.75, -0.2);
  bodyGroup.add(seat);

  const wheelMat = track(new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9, transparent: true, opacity: 1 }));
  const wheelGeom = track(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12));
  const wheelOffsets = [
    [0.85, 0.15, 0.85],
    [-0.85, 0.15, 0.85],
    [0.85, 0.15, -0.85],
    [-0.85, 0.15, -0.85],
  ];
  const wheels = wheelOffsets.map(([x, y, z]) => {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    bodyGroup.add(wheel);
    return wheel;
  });

  // ブースト中の炎(後方の円錐)
  const flameMat = track(new THREE.MeshStandardMaterial({ color: 0xff7a1a, emissive: 0xff4400, emissiveIntensity: 1.2, transparent: true, opacity: 0.9 }));
  const flameGeom = track(new THREE.ConeGeometry(0.3, 1.0, 10));
  const flame = new THREE.Mesh(flameGeom, flameMat);
  flame.rotation.x = -Math.PI / 2;
  flame.position.set(0, 0.35, -1.6);
  flame.visible = false;
  bodyGroup.add(flame);

  // Shield 中の半透明の球
  const shieldMat = track(new THREE.MeshStandardMaterial({ color: 0x4fd6ff, transparent: true, opacity: 0.35, roughness: 0.1 }));
  const shieldGeom = track(new THREE.SphereGeometry(1.6, 16, 12));
  const shield = new THREE.Mesh(shieldGeom, shieldMat);
  shield.position.y = 0.5;
  shield.visible = false;
  group.add(shield);

  // 名前(自分のカートには出さない)
  let nameSprite = null;
  if (showName) {
    const tex = track(makeNameTexture(name || ''));
    const spriteMat = track(new THREE.SpriteMaterial({ map: tex, transparent: true }));
    nameSprite = new THREE.Sprite(spriteMat);
    nameSprite.scale.set(2.4, 0.6, 1);
    nameSprite.position.y = 2.0;
    group.add(nameSprite);
  }

  function setOpacity(opacity) {
    bodyMat.opacity = opacity;
    seatMat.opacity = opacity;
    wheelMat.opacity = opacity;
  }

  function dispose() {
    for (const obj of disposables) obj.dispose();
  }

  return { group, bodyGroup, flame, shield, wheels, nameSprite, setOpacity, dispose };
}

/**
 * `cfg.colors` と `roster` からカートのプールを作る。roster は初期の色・名前の手がかりに使うだけで、
 * 実際の表示は毎フレーム `view.self` / `view.others` から更新する(離脱・追加にも追従する)。
 * @param {THREE.Scene} scene
 * @param {object} cfg
 * @param {Array<{slot:number,name:string,kind:string,local:boolean}>} roster
 * @returns {{ update(view: object, dt: number): void, dispose(): void }}
 */
export function createKartPool(scene, cfg, roster) {
  const karts = new Map(); // slot -> kart

  function ensureKart(slot, color, name, showName) {
    let kart = karts.get(slot);
    if (!kart) {
      kart = createKart(color, name, showName);
      scene.add(kart.group);
      karts.set(slot, kart);
    }
    return kart;
  }

  function applyEntry(entry, showName) {
    const color = entry.color !== undefined ? entry.color : (cfg.colors ? cfg.colors[entry.slot % cfg.colors.length] : 0xffffff);
    const kart = ensureKart(entry.slot, color, entry.name, showName);
    kart.group.position.set(entry.x, 0, entry.z);
    kart.group.rotation.y = entry.yaw;
    kart.bodyGroup.rotation.y = entry.spinVisual || 0;
    kart.flame.visible = !!entry.boosting;
    kart.shield.visible = !!entry.shield;
    kart.setOpacity(entry.finished ? 0.4 : 1);
    kart.group.visible = true;
    return entry.slot;
  }

  /**
   * @param {object} view RenderView(self / others を使う)
   * @param {number} dt
   */
  function update(view, dt) {
    void dt;
    if (!view) return;
    const seen = new Set();
    if (view.self) {
      seen.add(applyEntry(view.self, false));
    }
    if (view.others) {
      for (const other of view.others) {
        seen.add(applyEntry(other, true));
      }
    }
    // 表示から消えた(抜けた)カートは片付ける(設計書 12節「抜けた人のカートは消す」)
    for (const [slot, kart] of karts) {
      if (!seen.has(slot)) {
        scene.remove(kart.group);
        kart.dispose();
        karts.delete(slot);
      }
    }
  }

  function dispose() {
    for (const kart of karts.values()) {
      scene.remove(kart.group);
      kart.dispose();
    }
    karts.clear();
  }

  // roster の情報だけでは動かないので、ここでは何も作らない(update が初回描画で作る)。
  void roster;

  return { update, dispose };
}
