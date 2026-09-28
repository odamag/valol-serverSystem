/**
 * `ticker.js` が裏タブのときだけ使う Worker(約束 6節)。メインスレッドの `setInterval` はブラウザに
 * 強く間引かれるので、Worker 側で 60Hz の `tick` を打ち、`update` だけを呼び続けられるようにする。
 */
let intervalId = null;

self.onmessage = (event) => {
  const type = event && event.data && event.data.type;
  if (type === 'start') {
    if (intervalId != null) return; // 二重に start しても増やさない
    intervalId = setInterval(() => {
      self.postMessage({ type: 'tick' });
    }, 1000 / 60);
  } else if (type === 'stop') {
    if (intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }
};
