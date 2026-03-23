import { useState, useEffect, createContext, useContext } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import ServerControl from './pages/ServerControl.jsx'
import MiniGames from './pages/MiniGames.jsx'
import Profile from './pages/Profile.jsx'
import Info from './pages/Info.jsx'
import LoLInfo from './pages/LoLInfo.jsx'
import LoLStreak from './pages/LoLStreak.jsx'

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
            <Route
              path="profile"
              element={auth.loggedIn ? <Profile /> : <Navigate to="/login" replace />}
            />
          </Route>
          <Route path="*" element={<Navigate to="/server" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthContext.Provider>
  )
}

export default App
