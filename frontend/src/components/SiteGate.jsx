import { useState, useEffect } from 'react'

const SITE_TOKEN_KEY = 'siteDeviceToken'

export default function SiteGate({ children }) {
  // 'checking' | 'device_checking' | 'authenticated' | 'unauthenticated'
  const [status, setStatus] = useState('checking')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // ① まずセッションが生きているか確認
    fetch('/api/auth/site_status.php', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.authenticated) {
          setStatus('authenticated')
          return
        }
        // ② セッションなし → localStorageのデバイストークンを試みる
        const token = localStorage.getItem(SITE_TOKEN_KEY)
        if (!token) {
          setStatus('unauthenticated')
          return
        }
        setStatus('device_checking')
        fetch('/api/auth/site_device_login.php', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceToken: token }),
        })
          .then(r => r.json())
          .then(d => {
            if (d.success) {
              setStatus('authenticated')
            } else {
              localStorage.removeItem(SITE_TOKEN_KEY)
              setStatus('unauthenticated')
            }
          })
          .catch(() => setStatus('unauthenticated'))
      })
      .catch(() => setStatus('unauthenticated'))
  }, [])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/site_login.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await res.json()
      if (data.success) {
        if (data.deviceToken) {
          localStorage.setItem(SITE_TOKEN_KEY, data.deviceToken)
        }
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

  if (status === 'checking' || status === 'device_checking') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">🔒</div>
          <h1 className="auth-title">接続確認中</h1>
          <p className="auth-subtitle">
            {status === 'device_checking' ? 'デバイスを認証中...' : '確認中...'}
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
