/**
 * 追いかけカメラと後方視点(設計書 12節)。`three` の Camera オブジェクトを直接動かすのでブラウザ専用。
 * 向きの計算には `core/math.js` の純粋関数を使う(DOM・three には触れていないので問題ない)。
 */
import { forwardVec } from '../core/math.js';

const CHASE_BACK = 7;
const CHASE_UP = 3.2;
const CHASE_LOOK_AHEAD = 4;
const CHASE_LOOK_UP = 1.0;

const REAR_FRONT = 6;
const REAR_UP = 3;
const REAR_LOOK_BACK = 10;
const REAR_LOOK_UP = 1.5;

const FOV_NORMAL = 70;
const FOV_BOOST = 80;
const FOLLOW_RATE = 8; // pos += (target-pos) * (1 - exp(-rate*dt))

/**
 * @param {import('three').PerspectiveCamera} camera
 * @returns {{ update(view: object, dt: number): void }}
 */
export function createCameraRig(camera) {
  let initialized = false;
  let wasLookBack = false;

  function update(view, dt) {
    const self = view && view.self;
    if (!self) return;

    const fwd = forwardVec(self.yaw);
    const lookBack = !!view.lookBack;

    let targetPos;
    let lookAt;
    if (lookBack) {
      targetPos = { x: self.x + fwd.x * REAR_FRONT, y: REAR_UP, z: self.z + fwd.z * REAR_FRONT };
      lookAt = { x: self.x - fwd.x * REAR_LOOK_BACK, y: REAR_LOOK_UP, z: self.z - fwd.z * REAR_LOOK_BACK };
    } else {
      targetPos = { x: self.x - fwd.x * CHASE_BACK, y: CHASE_UP, z: self.z - fwd.z * CHASE_BACK };
      lookAt = { x: self.x + fwd.x * CHASE_LOOK_AHEAD, y: CHASE_LOOK_UP, z: self.z + fwd.z * CHASE_LOOK_AHEAD };
    }

    // 後方視点への切り替え・復帰は補間せずに一瞬で切り替える(設計書 12節)
    const snap = !initialized || lookBack !== wasLookBack;
    if (snap) {
      camera.position.set(targetPos.x, targetPos.y, targetPos.z);
    } else {
      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      camera.position.x += (targetPos.x - camera.position.x) * k;
      camera.position.y += (targetPos.y - camera.position.y) * k;
      camera.position.z += (targetPos.z - camera.position.z) * k;
    }
    camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

    const targetFov = self.boosting ? FOV_BOOST : FOV_NORMAL;
    const fk = snap ? 1 : 1 - Math.exp(-FOLLOW_RATE * dt);
    camera.fov += (targetFov - camera.fov) * fk;
    camera.updateProjectionMatrix();

    wasLookBack = lookBack;
    initialized = true;
  }

  return { update };
}
