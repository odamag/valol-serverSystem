/**
 * 弾・油のメッシュのプール(設計書 12節)。`view.objects` の id をキーにメッシュを使い回す。
 * ブラウザ専用(`three` を直接使う)。
 */
import * as THREE from 'three';

const OIL_FLOAT_HEIGHT = 0.6; // Oil が active でない(投擲中)ときに少し浮かせる高さ

function createRocket() {
  const geom = new THREE.ConeGeometry(0.35, 1.6, 10);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff6a1a, emissive: 0x992200, emissiveIntensity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = Math.PI / 2; // 円錐の先端が +Z(前方)を向くようにする
  mesh.position.y = 0.4;
  return { mesh, geoms: [geom], mats: [mat] };
}

function createHoming() {
  const group = new THREE.Group();
  const sphereGeom = new THREE.SphereGeometry(0.4, 16, 12);
  const sphereMat = new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0x5b0e9e, emissiveIntensity: 0.5 });
  const sphere = new THREE.Mesh(sphereGeom, sphereMat);
  sphere.position.y = 0.4;
  group.add(sphere);

  const ringGeom = new THREE.TorusGeometry(0.6, 0.06, 8, 24);
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xd6a8ff, emissive: 0xd6a8ff, emissiveIntensity: 0.8 });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.position.y = 0.4;
  ring.rotation.x = Math.PI / 2;
  group.add(ring);

  return { mesh: group, geoms: [sphereGeom, ringGeom], mats: [sphereMat, ringMat], extra: { ring } };
}

function createOil() {
  const geom = new THREE.CylinderGeometry(1.8, 1.8, 0.15, 20);
  const mat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.3, metalness: 0.2 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.y = 0.08;
  return { mesh, geoms: [geom], mats: [mat] };
}

const FACTORIES = { Rocket: createRocket, Homing: createHoming, Oil: createOil };

/**
 * @param {THREE.Scene} scene
 * @param {object} cfg
 * @returns {{ update(view: object, dt: number): void, dispose(): void }}
 */
export function createObjectPool(scene, cfg) {
  void cfg;
  const instances = new Map(); // id -> { type, mesh, geoms, mats, extra }
  let t = 0;

  function ensure(obj) {
    let inst = instances.get(obj.id);
    if (inst && inst.type !== obj.type) {
      // 型が変わることは通常ないが、念のため作り直す
      scene.remove(inst.mesh);
      disposeInst(inst);
      instances.delete(obj.id);
      inst = null;
    }
    if (!inst) {
      const factory = FACTORIES[obj.type];
      if (!factory) return null;
      const built = factory();
      inst = { type: obj.type, ...built };
      scene.add(inst.mesh);
      instances.set(obj.id, inst);
    }
    return inst;
  }

  function disposeInst(inst) {
    for (const g of inst.geoms) g.dispose();
    for (const m of inst.mats) m.dispose();
  }

  /**
   * @param {object} view RenderView(objects を使う)
   * @param {number} dt
   */
  function update(view, dt) {
    t += dt;
    const objs = (view && view.objects) || [];
    const seen = new Set();
    for (const obj of objs) {
      const inst = ensure(obj);
      if (!inst) continue;
      seen.add(obj.id);
      inst.mesh.position.x = obj.x;
      inst.mesh.position.z = obj.z;
      inst.mesh.rotation.y = obj.yaw;
      if (inst.type === 'Oil') {
        inst.mesh.position.y = obj.active ? 0 : OIL_FLOAT_HEIGHT;
      } else if (inst.type === 'Homing' && inst.extra) {
        inst.extra.ring.rotation.z = t * 4;
      }
    }
    for (const [id, inst] of instances) {
      if (!seen.has(id)) {
        scene.remove(inst.mesh);
        disposeInst(inst);
        instances.delete(id);
      }
    }
  }

  function dispose() {
    for (const inst of instances.values()) {
      scene.remove(inst.mesh);
      disposeInst(inst);
    }
    instances.clear();
  }

  return { update, dispose };
}
