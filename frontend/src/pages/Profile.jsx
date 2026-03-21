import { useAuth } from '../App.jsx'

export default function Profile() {
  const { auth, setAuth } = useAuth()

  async function handleDelete() {
    if (!confirm('本当にアカウントを削除しますか？この操作は取り消せません。')) return
    try {
      const res = await fetch('/api/auth/profile.php', {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()
      if (data.success) {
        setAuth({ loading: false, loggedIn: false, username: null, userId: null })
      } else {
        alert(data.message ?? '削除に失敗しました')
      }
    } catch {
      alert('通信エラーが発生しました')
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">👤 プロフィール</h1>
        <p className="page-subtitle">アカウント情報を確認・管理できます</p>
      </div>

      <div className="card profile-card">
        <div className="user-info-row">
          <span className="user-info-label">ユーザー名</span>
          <span className="user-info-value">{auth.username}</span>
        </div>
        <div className="user-info-row">
          <span className="user-info-label">ユーザーID</span>
          <span className="user-info-value" style={{ fontFamily: 'monospace' }}>
            {auth.userId}
          </span>
        </div>
      </div>

      <div className="danger-zone">
        <p className="danger-zone-title">危険な操作</p>
        <p>アカウントを削除するとログインできなくなります。この操作は取り消せません。</p>
        <button className="btn btn-danger" onClick={handleDelete}>
          アカウントを削除する
        </button>
      </div>
    </>
  )
}
