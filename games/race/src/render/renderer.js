/**
 * 描画のエントリポイント(設計書 10.2節 RenderView、12節)。`createRenderer` はコース・カート・弾/油・カメラを
 * まとめ、毎フレーム `render(view, dt)` で `RenderView` を受け取って描く。ブラウザ専用(`three` を直接使う)。
 */
import * as THREE from 'three';
import { buildCourseMesh } from './courseMesh.js';
import { createKartPool } from './kartMesh.js';
import { createObjectPool } from './objects.js';
import { createCameraRig } from './camera.js';

const FOG_NEAR = 150;
const FOG_FAR = 400;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} course `buildCourse()` の戻り値
 * @param {object} cfg `makeConfig()` の戻り値
 * @param {Array<{slot:number,name:string,kind:string,local:boolean}>} roster
 * @returns {{ render(view: object, dt: number): void, resize(): void, dispose(): void }}
 */
export function createRenderer(canvas, course, cfg, roster) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const skyColor = 0xbfd9ff;
  scene.background = new THREE.Color(skyColor);
  scene.fog = new THREE.Fog(skyColor, FOG_NEAR, FOG_FAR);

  const hemiLight = new THREE.HemisphereLight(skyColor, 0x4a7a3a, 1.1);
  scene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(60, 90, 40);
  scene.add(dirLight);

  const courseMesh = buildCourseMesh(course, cfg);
  scene.add(courseMesh.group);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  const cameraRig = createCameraRig(camera);

  const kartPool = createKartPool(scene, cfg, roster);
  const objectPool = createObjectPool(scene, cfg);

  /** キャンバスの実サイズに合わせて描画解像度とカメラのアスペクト比を合わせ直す */
  function resize() {
    const width = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();
  const onWindowResize = () => resize();
  window.addEventListener('resize', onWindowResize);

  /**
   * @param {object} view RenderView(設計書 10.2節)
   * @param {number} dt 秒
   */
  function render(view, dt) {
    courseMesh.update(view, dt);
    kartPool.update(view, dt);
    objectPool.update(view, dt);
    cameraRig.update(view, dt);
    renderer.render(scene, camera);
  }

  function dispose() {
    window.removeEventListener('resize', onWindowResize);
    courseMesh.dispose();
    kartPool.dispose();
    objectPool.dispose();
    scene.clear();
    renderer.dispose();
  }

  return { render, resize, dispose };
}
