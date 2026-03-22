import { Outlet } from 'react-router-dom'
import { useState } from 'react'
import Sidebar from './Sidebar.jsx'

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="app-layout">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
      <main className="main-content">
        <button
          className="menu-toggle"
          onClick={() => setSidebarOpen(true)}
          aria-label="メニューを開く"
        >
          ☰
        </button>
        <Outlet />
      </main>
    </div>
  )
}
