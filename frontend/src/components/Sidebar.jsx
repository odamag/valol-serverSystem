import { NavLink } from 'react-router-dom'
import { useAuth } from '../App.jsx'

const navItems = [
  { to: '/server', label: 'サーバー起動', icon: '⚡' },
  { to: '/games',  label: 'ミニゲーム',   icon: '🎮' },
  { to: '/info',   label: '情報',          icon: '📋' },
  { to: '/lol',    label: 'LoL情報',       icon: '⚔️' },
]

export default function Sidebar({ isOpen, onClose }) {
  const { auth, setAuth } = useAuth()

  async function handleLogout() {
    await fetch('/api/auth/logout.php', { method: 'POST', credentials: 'include' })
    setAuth({ loading: false, loggedIn: false, username: null, userId: null })
    onClose?.()
  }

  return (
    <aside className={`sidebar${isOpen ? ' sidebar--open' : ''}`}>
      <div className="sidebar-brand">
        <span className="brand-icon">🖥️</span>
        <span>Server System</span>
      </div>

      <nav className="sidebar-nav">
        <span className="sidebar-section-label">メニュー</span>
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            onClick={onClose}
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-footer">
        {auth.loggedIn ? (
          <>
            <NavLink
              to="/profile"
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="nav-icon">👤</span>
              <span>{auth.username}</span>
            </NavLink>
            <button className="logout-btn" onClick={handleLogout}>
              <span className="nav-icon">🚪</span>
              <span>ログアウト</span>
            </button>
          </>
        ) : (
          <NavLink
            to="/login"
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon">🔐</span>
            <span>ログイン</span>
          </NavLink>
        )}
      </div>
    </aside>
  )
}
