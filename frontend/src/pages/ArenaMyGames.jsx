import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

export default function ArenaMyGames() {
  const [games, setGames] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [allRes, mineRes] = await Promise.all([
          arenaApi.get('/v1/games'),
          arenaApi.get('/v1/me/games'),
        ])
        setGames(allRes.games)
        setSelected(new Set(mineRes.games.map(g => g.slug)))
      } catch (e) {
        setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function toggle(slug) {
    setSaved(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(slug)) {
        next.delete(slug)
      } else {
        next.add(slug)
      }
      return next
    })
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await arenaApi.put('/v1/me/games', { slugs: Array.from(selected) })
      setSaved(true)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎴 所持ゲーム設定</h1>
        <p className="page-subtitle">
          対戦候補に出すのは「自分と相手の両方が所持しているゲーム」だけです。持っているゲームにチェックを入れてください。
        </p>
      </div>

      <div className="card arena-card">
        {loading && <p className="arena-loading">読み込み中…</p>}
        {error && <p className="arena-msg arena-msg--err">{error}</p>}

        {!loading && games.length === 0 && (
          <p className="arena-empty">
            まだゲームが登録されていません。<Link to="/arena/admin">ゲームマスタ管理</Link>から追加してください。
          </p>
        )}

        {!loading && games.length > 0 && (
          <>
            <ul className="arena-checklist">
              {games.map(g => (
                <li key={g.slug} className="arena-checklist-item">
                  <label className="arena-checklist-label">
                    <input
                      type="checkbox"
                      checked={selected.has(g.slug)}
                      onChange={() => toggle(g.slug)}
                    />
                    <span className="arena-checklist-icon">{g.icon || '🎮'}</span>
                    <span>{g.name}</span>
                  </label>
                </li>
              ))}
            </ul>

            <div className="arena-form-actions">
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? '保存中…' : '保存する'}
              </button>
              {saved && <span className="arena-msg arena-msg--ok">保存しました</span>}
            </div>
          </>
        )}
      </div>
    </>
  )
}
