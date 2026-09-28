/**
 * 裏タブでも `update` を止めないループ(約束 6節)。Worker(`ticker.worker.js`)の 60Hz のメッセージで
 * `update` を常に呼び、見えている間は `requestAnimationFrame` で `update` と `render` を呼ぶ。
 * Worker を見えている間も動かすのは、ウィンドウが他のウィンドウに隠れている等で document.hidden が false のまま
 * rAF だけが 1Hz 程度に間引かれることがあるため(ブラウザで見つけた点)。update は時刻で進むので、
 * 2か所から呼ばれても進み方は変わらない。`now` は `performance.now()`。
 *
 * @param {(now: number) => void} onUpdate
 * @param {(now: number) => void} onRender
 * @returns {{ start(): void, stop(): void }}
 */
export function createTicker(onUpdate, onRender) {
  let running = false;
  let rafId = null;
  let worker = null;

  function loop(now) {
    if (!running) return;
    onUpdate(now);
    onRender(now);
    rafId = requestAnimationFrame(loop);
  }

  function startForeground() {
    rafId = requestAnimationFrame(loop);
  }

  function stopForeground() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./ticker.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      if (!running) return;
      if (event && event.data && event.data.type === 'tick') onUpdate(performance.now());
    };
    return worker;
  }

  function startBackground() {
    ensureWorker().postMessage({ type: 'start' });
  }

  function stopBackground() {
    if (worker) worker.postMessage({ type: 'stop' });
  }

  function onVisibilityChange() {
    if (!running) return;
    if (document.hidden) stopForeground();
    else if (rafId == null) startForeground();
  }

  function start() {
    if (running) return;
    running = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    startBackground();
    if (!document.hidden) startForeground();
  }

  function stop() {
    if (!running) return;
    running = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    stopForeground();
    stopBackground();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return { start, stop };
}
