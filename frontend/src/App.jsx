import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
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
import ArenaDraft from './pages/ArenaDraft.jsx'
import ArenaMatch from './pages/ArenaMatch.jsx'
import ArenaRanking from './pages/ArenaRanking.jsx'
import ArenaHeadToHead from './pages/ArenaHeadToHead.jsx'
import ArenaStats from './pages/ArenaStats.jsx'

export const AuthContext = createContext(null)

export function useAuth() {
  return useContext(AuthContext)
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
                path="arena/stats/:slug"
                element={auth.loggedIn ? <ArenaStats /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/draft/:publicId"
                element={auth.loggedIn ? <ArenaDraft /> : <Navigate to="/login" replace />}
              />
              <Route
                path="arena/:publicId"
                element={auth.loggedIn ? <ArenaMatch /> : <Navigate to="/login" replace />}
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
