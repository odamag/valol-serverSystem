import { useState, useEffect } from 'react'

// 旧実装が localStorage に置いていたデバイストークンのキー。今は Cookie に統合したので、起動時に消す。
const LEGACY_SITE_TOKEN_KEY = 'siteDeviceToken'

export default function SiteGate({ children }) {
  // 'checking' | 'authenticated' | 'unauthenticated'
  const [status, setStatus] = useState('checking')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    try { localStorage.removeItem(LEGACY_SITE_TOKEN_KEY) } catch { /* 無視 */ }
    fetch('/api/v1/site/status', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setStatus(data.authenticated ? 'authenticated' : 'unauthenticated'))
      .catch(() => setStatus('unauthenticated'))
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/v1/site/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      // 401（合言葉違い）・429（回数制限）は返ってきた message をそのまま出す
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.success) {
        setStatus('authenticated')
      } else {
        setError(data.message ?? '認証に失敗しました')
      }
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  if (status === 'authenticated') {
    return children
  }

  if (status === 'checking') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">🔒</div>
          <h1 className="auth-title">接続確認中</h1>
          <p className="auth-subtitle">
            確認中...
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', margin: '1.5rem 0' }}>
            <div className="loading-spinner" />
          </div>
        </div>
      </div>
    )
  }

  // unauthenticated: パスワード入力フォーム
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">🔒</div>
        <h1 className="auth-title">アクセス制限</h1>
        <p className="auth-subtitle">サイトパスワードを入力してください</p>

        <div className="alert alert-info">
          2026年11月27日に合言葉を変更しました。新しい合言葉は管理者から個別にお伝えします。詳しくは、入室後の「情報」ページのお知らせをご覧ください。
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">パスワード</label>
            <input
              className="form-input"
              type="password"
              placeholder="パスワード"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              autoFocus
            />
          </div>
          <button className="btn-submit" type="submit" disabled={loading}>
            {loading ? '認証中...' : 'アクセス'}
          </button>
        </form>
      </div>
    </div>
  )
}
