import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { isSafeInternalPath } from './lib/urlSafety.js'
import Layout from './components/Layout.jsx'
import SiteGate from './components/SiteGate.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import ServerControl from './pages/ServerControl.jsx'
import MiniGames from './pages/MiniGames.jsx'
import Profile from './pages/Profile.jsx'
import Info from './pages/Info.jsx'
import LoLInfo from './pages/LoLInfo.jsx'
import LoLStreak from './pages/LoLStreak.jsx'
import LoLPredict from './pages/LoLPredict.jsx'
import ValorantPredict from './pages/ValorantPredict.jsx'
import ArenaHome from './pages/ArenaHome.jsx'
import ArenaMyGames from './pages/ArenaMyGames.jsx'
import ArenaAdmin from './pages/ArenaAdmin.jsx'
import ArenaSeries from './pages/ArenaSeries.jsx'
import ArenaRanking from './pages/ArenaRanking.jsx'
import ArenaHeadToHead from './pages/ArenaHeadToHead.jsx'
import RunningHome from './pages/RunningHome.jsx'
import RunningRanking from './pages/RunningRanking.jsx'
import RunningRecords from './pages/RunningRecords.jsx'

export const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
}

// 未ログインならログイン画面へ送り、ログイン後に元のページへ戻れるよう行き先を控えておく
function RequireLogin({ to, children }) {
  const { auth } = useAuth()
  if (auth.loggedIn) return children
  // sessionStorage への書き込みは冪等な副作用なので描画中に行って差し支えない。
  // Discord OAuth はページ遷移を伴い React の state が消えるため、state ではなく
  // sessionStorage に置く必要がある。
  sessionStorage.setItem('postLoginRedirect', to)
  return <Navigate to={`/login?next=${encodeURIComponent(to)}`} replace />
}

// Discord OAuth はページリロードを挟むため、ログイン完了後にここで行き先を回収する
function PostLoginRedirect() {
  const { auth } = useAuth()
  const navigate = useNavigate()
  useEffect(() => {
    if (!auth.loggedIn) return
    const dest = sessionStorage.getItem('postLoginRedirect')
    if (!dest) return
    sessionStorage.removeItem('postLoginRedirect')
    if (isSafeInternalPath(dest)) navigate(dest, { replace: true })
  }, [auth.loggedIn, navigate])
  return null
}

function App() {
  const [auth, setAuth] = useState({ loading: true, loggedIn: false, username: null, userId: null })

  useEffect(() => {
    fetch('/api/auth/status.php', { credentials: 'include' })
      .then(r => r.json())
      .then(data => setAuth({ loading: false, ...data }))
      .catch(() => setAuth({ loading: false, loggedIn: false }))
  }, [])

  if (auth.loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>読み込み中...</p>
      </div>
    )
  }

  return (
    <SiteGate>
      <AuthContext.Provider value={{ auth, setAuth }}>
        <BrowserRouter>
          <PostLoginRedirect />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/" element={<Layout />}>
              <Route index element={<Navigate to="/server" replace />} />
              <Route path="server" element={<ServerControl />} />
              <Route path="games" element={<MiniGames />} />
              <Route path="info" element={<Info />} />
              <Route path="lol" element={<LoLInfo />} />
              <Route path="lol-streak" element={<LoLStreak />} />
              <Route path="lol-predict" element={<LoLPredict />} />
              <Route path="val-predict" element={<ValorantPredict />} />
              <Route
                path="profile"
                element={auth.loggedIn ? <Profile /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena"
                element={auth.loggedIn ? <ArenaHome /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/my-games"
                element={auth.loggedIn ? <ArenaMyGames /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/admin"
                element={auth.loggedIn ? <ArenaAdmin /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/ranking"
                element={auth.loggedIn ? <ArenaRanking /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/head-to-head"
                element={auth.loggedIn ? <ArenaHeadToHead /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/:publicId"
                element={auth.loggedIn ? <ArenaSeries /> : <Navigate to="/login" replace />}
              />
              <Route
                path="running"
                element={<RequireLogin to="/running"><RunningHome /></RequireLogin>}
              />
              <Route
                path="running/ranking"
                element={<RequireLogin to="/running/ranking"><RunningRanking /></RequireLogin>}
              />
              <Route
                path="running/records"
                element={<RequireLogin to="/running/records"><RunningRecords /></RequireLogin>}
              />
            </Route>
            <Route path="*" element={<Navigate to="/server" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthContext.Provider>
    </SiteGate>
  )
}

export default App
