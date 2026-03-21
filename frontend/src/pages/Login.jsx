import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App.jsx'

export default function Login() {
  const { setAuth } = useAuth()
  const navigate = useNavigate()
  const [id, setId] = useState('')
  const [otp, setOtp] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, otp }),
      })
      const data = await res.json()
      if (data.success) {
        setAuth({ loading: false, loggedIn: true, username: data.username, userId: data.userId })
        navigate('/server')
      } else {
        setError(data.message ?? 'ログインに失敗しました')
      }
    } catch {
      setError('通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">🔐</div>
        <h1 className="auth-title">ログイン</h1>
        <p className="auth-subtitle">IDとOTPを入力してください</p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">ユーザーID</label>
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
            <label className="form-label">OTP（6桁）</label>
            <input
              className="form-input"
              type="text"
              inputMode="numeric"
              placeholder="000000"
              maxLength={6}
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
              required
            />
          </div>
          <button className="btn-submit" type="submit" disabled={loading}>
            {loading ? 'ログイン中...' : 'ログイン'}
          </button>
        </form>

        <p className="auth-link">
          アカウントをお持ちでない方は <Link to="/register">アカウント作成</Link>
        </p>
      </div>
    </div>
  )
}
