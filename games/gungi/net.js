/**
 * 軍儀 (Gungi) - PeerJS P2P通信レイヤー
 * pong_p2p と同じ「合言葉」方式(host id / guest id)でマッチングする。
 * このゲームはターン制なので、毎フレームの状態同期ではなく「行動(アクション)」単位で
 * メッセージを送り合い、両クライアントが同じ決定的ルールエンジンをローカルで走らせる方式を取る。
 */
(function (root) {
  'use strict';

  var peer = null;
  var conn = null;
  var isHostFlag = false;
  var handlers = {};

  function on(event, fn) { handlers[event] = fn; }
  function fire(event, payload) { if (handlers[event]) handlers[event](payload); }

  function join(roomNameRaw) {
    var roomName = roomNameRaw.replace(/[^a-zA-Z0-9]/g, '');
    if (!roomName) { fire('status', '合言葉を英数字で入力してください'); return; }

    var hostId = 'gungi-' + roomName + '-1';
    var guestId = 'gungi-' + roomName + '-2';

    fire('status', '接続を試みています...');
    peer = new Peer(hostId);

    peer.on('open', function () {
      isHostFlag = true;
      fire('status', '対戦相手を待っています... (合言葉: ' + roomName + ')');
      peer.on('connection', function (connection) {
        conn = connection;
        wireConnection();
      });
    });

    peer.on('error', function (err) {
      if (err.type === 'id-taken' || err.type === 'unavailable-id') {
        if (peer) peer.destroy();
        startAsGuest(roomName, hostId, guestId);
      } else {
        fire('status', 'エラーが発生しました: ' + err.type);
        fire('error', err);
      }
    });
  }

  function startAsGuest(roomName, hostId, guestId) {
    peer = new Peer(guestId);
    peer.on('open', function () {
      isHostFlag = false;
      fire('status', 'ホストに接続中...');
      conn = peer.connect(hostId);
      wireConnection();
    });
    peer.on('error', function (err) {
      fire('status', 'エラーが発生しました: ' + err.type);
      fire('error', err);
    });
  }

  function wireConnection() {
    conn.on('open', function () {
      fire('connected', { isHost: isHostFlag });
    });
    conn.on('data', function (data) {
      fire('data', data);
    });
    conn.on('close', function () {
      fire('disconnected');
    });
  }

  function send(obj) {
    if (conn && conn.open) conn.send(obj);
  }

  function isHost() { return isHostFlag; }

  root.Gungi = root.Gungi || {};
  root.Gungi.Net = { join: join, send: send, isHost: isHost, on: on };
})(typeof window !== 'undefined' ? window : this);
