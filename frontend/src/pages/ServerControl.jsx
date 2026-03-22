import { useState, useEffect, useCallback, useRef } from 'react'

const STATUS_LABELS = {
  ready:   { label: '✨ オンライン',      cls: 'ready' },
  loading: { label: '⏳ 起動処理中...',   cls: 'loading' },
  pending: { label: '🚀 サーバー準備中...', cls: 'pending' },
  closing: { label: '🔴 終了処理中...',   cls: 'closing' },
  stopped: { label: '停止中',             cls: 'stopped' },
}

function ServerCard({ serverKey, server, onAction, actionLoading }) {
  const { label, cls } = STATUS_LABELS[server.displayState] ?? STATUS_LABELS.stopped

  async function copyIp() {
    const text = `${server.ip}:${server.port}`
    await navigator.clipboard.writeText(text)
    alert(`コピーしました: ${text}`)
  }

  return (
    <div className="server-card">
      <div className={`server-card-header ${serverKey}`}>
        <span>{server.name}</span>
      </div>
      <div className="server-card-body">
        <div className={`status-badge ${cls}`}>{label}</div>

        {server.displayState === 'ready' && (
          <>
            <p className="server-info-text">IPをタップしてコピー</p>
            <div className="ip-box" onClick={copyIp} role="button" tabIndex={0}>
              <span>{server.ip}:{server.port}</span>
              <span className="ip-copy-hint">📋 コピー</span>
            </div>
            <button
              className="btn btn-danger"
              disabled={actionLoading}
              onClick={() => {
                if (confirm('本当に停止しますか？')) {
                  onAction('stop', serverKey, server.instanceId)
                }
              }}
            >
              停止
            </button>
          </>
        )}

        {server.displayState === 'loading' && (
          <p className="server-info-text">起動完了まで数分かかります。自動更新中...</p>
        )}

        {server.displayState === 'pending' && (
          <p className="server-info-text">インスタンスを作成しています...</p>
        )}

        {server.displayState === 'closing' && (
          <>
            <p className="server-info-text">データを保存して電源を切っています。完全に消えるまで数分お待ちください。</p>
            <button className="btn btn-secondary" disabled>起動できません</button>
          </>
        )}

        {server.displayState === 'stopped' && (
          <button
            className="btn btn-primary"
            disabled={actionLoading}
            onClick={() => onAction('start', serverKey, null)}
          >
            {actionLoading ? '🚀 起動リクエスト中...' : '起動する'}
          </button>
        )}
      </div>
    </div>
  )
}

export default function ServerControl() {
  const [servers, setServers] = useState(null)
  const [message, setMessage] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const prevServersRef = useRef({})

  function fireNotification(server) {
    if (Notification.permission !== 'granted') return
    new Notification(`${server.name} が起動しました！`, {
      body: `接続先: ${server.ip}:${server.port}`,
      icon: '/favicon.ico',
    })
  }

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/server/status.php', { credentials: 'include' })
      const data = await res.json()
      if (data.servers) {
        const prev = prevServersRef.current
        for (const [key, server] of Object.entries(data.servers)) {
          if (server.displayState === 'ready' && prev[key]?.displayState !== 'ready') {
            fireNotification(server)
          }
        }
        prevServersRef.current = data.servers
        setServers(data.servers)
      }
      if (data.message) setMessage(data.message)
    } catch {
      /* silent */
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  async function handleAction(action, target, instanceId) {
    if (action === 'start' && Notification.permission === 'default') {
      await Notification.requestPermission()
    }
    setActionLoading(true)
    setMessage('')
    try {
      const res = await fetch('/api/server/control.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target, instanceId }),
      })
      const data = await res.json()
      if (data.message) setMessage(data.message)
      await fetchStatus()
    } catch {
      setMessage('通信エラーが発生しました')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">⚡ サーバー起動</h1>
        <p className="page-subtitle">Minecraft・Palworld・7 Days to Die の AWS サーバーを管理します</p>
      </div>

      {message && <div className="message-banner">{message}</div>}

      {servers === null ? (
        <div className="loading-screen" style={{ minHeight: 'unset', padding: '60px 0' }}>
          <div className="loading-spinner" />
          <p>サーバー情報を取得中...</p>
        </div>
      ) : (
        <div className="server-grid">
          {Object.entries(servers).map(([key, server]) => (
            <ServerCard
              key={key}
              serverKey={key}
              server={server}
              onAction={handleAction}
              actionLoading={actionLoading}
            />
          ))}
        </div>
      )}

      <p className="refresh-note">5秒ごとに自動更新</p>
    </>
  )
}
