import { useState } from 'react'
import { Link } from 'react-router-dom'

export default function Register() {
  const [id, setId] = useState('')
  const [username, setUsername] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/register.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, username }),
      })
      const data = await res.json()
      if (data.success) {
        setResult(data)
      } else {
        setError(data.message ?? 'アカウント作成に失敗しました')
      }
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  if (result) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-logo">✅</div>
          <h1 className="auth-title">登録完了</h1>
          <p className="auth-subtitle">以下のQRコードをGoogle Authenticatorでスキャンしてください</p>

          <div className="qr-section">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(result.otpUri)}`}
              alt="QR Code"
              width={200}
              height={200}
            />
            <p style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginBottom: 6 }}>
              シークレットキー（手動入力用）
            </p>
            <div className="secret-key-box">{result.secretKey}</div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4 }}>OTP URI</p>
            <div className="otp-uri-box">{result.otpUri}</div>
          </div>

          <div className="alert alert-success" style={{ marginTop: 16 }}>
            QRコードを必ずスキャンしてから次へ進んでください。<br />
            このページを閉じると再表示できません。
          </div>

          <p className="auth-link">
            スキャン完了後 → <Link to="/login">ログインへ</Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">👤</div>
        <h1 className="auth-title">アカウント作成</h1>
        <p className="auth-subtitle">IDとユーザー名を入力してください</p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">ユーザーID（ログインに使用）</label>
            <input
              className="form-input"
              type="text"
              placeholder="your-id"
              value={id}
              onChange={e => setId(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label">ユーザー名（表示名）</label>
            <input
              className="form-input"
              type="text"
              placeholder="Your Name"
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
            />
          </div>
          <button className="btn-submit" type="submit" disabled={loading}>
            {loading ? '作成中...' : 'アカウント作成'}
          </button>
        </form>

        <p className="auth-link">
          すでにアカウントをお持ちの方は <Link to="/login">ログイン</Link>
        </p>
      </div>
    </div>
  )
}
