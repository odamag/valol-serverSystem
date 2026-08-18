import { useState, useEffect, useCallback } from 'react'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

// ランキング（総合/ゲーム別）とヘッドトゥヘッド。
export default function ArenaRanking() {
  const [games, setGames] = useState([])
  const [selectedGame, setSelectedGame] = useState('overall')
  const [ranking, setRanking] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [users, setUsers] = useState([])
  const [h2hA, setH2hA] = useState('')
  const [h2hB, setH2hB] = useState('')
  const [h2hResult, setH2hResult] = useState(null)
  const [h2hError, setH2hError] = useState(null)

  useEffect(() => {
    arenaApi.get('/v1/games').then(data => setGames(data.games)).catch(() => {})
    arenaApi.get('/v1/users').then(data => setUsers(data.users)).catch(() => {})
  }, [])

  const loadRanking = useCallback(async (gameSlug) => {
    setLoading(true)
    setError(null)
    try {
      const data = await arenaApi.get(`/v1/ranking?game=${encodeURIComponent(gameSlug)}`)
      setRanking(data.ranking)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRanking(selectedGame) }, [selectedGame, loadRanking])

  async function handleH2h(e) {
    e.preventDefault()
    setH2hError(null)
    setH2hResult(null)
    if (!h2hA || !h2hB || h2hA === h2hB) {
      setH2hError('異なる2人を選んでください')
      return
    }
    try {
      const data = await arenaApi.get(`/v1/head-to-head?a=${h2hA}&b=${h2hB}`)
      setH2hResult(data)
    } catch (e) {
      setH2hError(errMsg(e))
    }
  }

  function usernameOf(id) {
    const u = users.find(u => String(u.id) === String(id))
    return u ? u.username : `#${id}`
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 ランキング</h1>
        <p className="page-subtitle">Elo レーティングによる対戦成績のランキングです</p>
      </div>

      <div className="card arena-card">
        <div className="arena-ranking-tabs">
          <button
            type="button"
            className={`arena-ranking-tab${selectedGame === 'overall' ? ' arena-ranking-tab--active' : ''}`}
            onClick={() => setSelectedGame('overall')}
          >
            🏆 総合
          </button>
          {games.map(g => (
            <button
              key={g.slug}
              type="button"
              className={`arena-ranking-tab${selectedGame === g.slug ? ' arena-ranking-tab--active' : ''}`}
              onClick={() => setSelectedGame(g.slug)}
            >
              {g.icon || '🎮'} {g.name}
            </button>
          ))}
        </div>

        {loading && <p className="arena-loading">読み込み中…</p>}
        {error && <p className="arena-msg arena-msg--err">{error}</p>}

        {!loading && !error && (
          ranking.length === 0 ? (
            <p className="arena-empty">まだ対戦記録がありません</p>
          ) : (
            <div className="arena-table-wrap">
              <table className="arena-ranking-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>プレイヤー</th>
                    <th>レート</th>
                    <th>戦績</th>
                    <th>連勝/連敗</th>
                  </tr>
                </thead>
                <tbody>
                  {ranking.map(r => (
                    <tr key={r.user_id}>
                      <td>{r.rank}</td>
                      <td>{r.username}</td>
                      <td>{r.rating}</td>
                      <td>{r.wins}勝{r.losses}敗</td>
                      <td>{r.streak > 0 ? `${r.streak}連勝` : r.streak < 0 ? `${-r.streak}連敗` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      <div className="card arena-card">
        <p className="arena-panel-title">ヘッドトゥヘッド</p>
        <form className="arena-h2h-form" onSubmit={handleH2h}>
          <select className="form-input" value={h2hA} onChange={e => setH2hA(e.target.value)}>
            <option value="">プレイヤーA</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
          <span>vs</span>
          <select className="form-input" value={h2hB} onChange={e => setH2hB(e.target.value)}>
            <option value="">プレイヤーB</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
          <button type="submit" className="btn btn-secondary arena-inline-btn">対戦成績を見る</button>
        </form>
        {h2hError && <p className="arena-msg arena-msg--err">{h2hError}</p>}
        {h2hResult && (
          <p className="arena-h2h-result">
            {usernameOf(h2hResult.a)} {h2hResult.a_wins} - {h2hResult.b_wins} {usernameOf(h2hResult.b)}
            {' '}（全 {h2hResult.matches.length} 戦）
          </p>
        )}
      </div>
    </>
  )
}
