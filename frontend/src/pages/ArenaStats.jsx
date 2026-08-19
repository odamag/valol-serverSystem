import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

function pct(v) {
  return v === null || v === undefined ? '-' : `${Math.round(v * 1000) / 10}%`
}

const COLUMNS = [
  { key: 'picks', label: 'PICK数' },
  { key: 'pick_rate', label: 'PICK率' },
  { key: 'bans', label: 'BAN数' },
  { key: 'ban_rate', label: 'BAN率' },
  { key: 'wins', label: '勝' },
  { key: 'losses', label: '敗' },
  { key: 'win_rate', label: '勝率' },
]

// ゲーム別のキャラ/エージェント統計。PICK率・BAN率・勝率をソート可能な表で見せる。
export default function ArenaStats() {
  const { slug } = useParams()
  const [users, setUsers] = useState([])
  const [userId, setUserId] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sortKey, setSortKey] = useState('picks')
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => {
    arenaApi.get('/v1/users').then(d => setUsers(d.users)).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const path = userId
        ? `/v1/games/${slug}/stats?user_id=${userId}`
        : `/v1/games/${slug}/stats`
      const res = await arenaApi.get(path)
      setData(res)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [slug, userId])

  useEffect(() => { load() }, [load])

  const sortedStats = useMemo(() => {
    if (!data) return []
    const rows = [...data.stats]
    rows.sort((x, y) => {
      const xv = x[sortKey]
      const yv = y[sortKey]
      const xn = xv === null || xv === undefined ? -1 : xv
      const yn = yv === null || yv === undefined ? -1 : yv
      return sortDir === 'asc' ? xn - yn : yn - xn
    })
    return rows
  }, [data, sortKey, sortDir])

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">📊 {data && data.game ? `${data.game.icon || '🎮'} ${data.game.name}` : ''} 統計</h1>
        <p className="page-subtitle">{data && data.game ? data.game.entry_label : 'キャラクター'}別のPICK率・BAN率・勝率です</p>
      </div>

      <div className="card arena-card">
        <div className="arena-form-grid">
          <div className="form-group">
            <label className="form-label">プレイヤーで絞り込み</label>
            <select className="form-input" value={userId} onChange={e => setUserId(e.target.value)}>
              <option value="">全員</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
          </div>
        </div>

        {loading && <p className="arena-loading">読み込み中…</p>}
        {error && <p className="arena-msg arena-msg--err">{error}</p>}

        {data && !loading && (
          <>
            <p className="arena-panel-desc">
              対象試合数: {data.total_matches}
              {userId && `（${users.find(u => String(u.id) === String(userId))?.username || ''} が参加した試合のみ）`}
            </p>

            {sortedStats.length === 0 ? (
              <p className="arena-empty">まだ統計データがありません</p>
            ) : (
              <div className="arena-table-wrap">
                <table className="arena-ranking-table arena-stats-table">
                  <thead>
                    <tr>
                      <th>{data.game.entry_label}</th>
                      {COLUMNS.map(c => (
                        <th
                          key={c.key}
                          className="arena-stats-sort-th"
                          onClick={() => handleSort(c.key)}
                        >
                          {c.label}{sortKey === c.key ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStats.map(s => (
                      <tr key={s.entry_id}>
                        <td className="arena-stats-entry-cell">
                          {s.entry_image_url && <img src={s.entry_image_url} alt="" className="arena-stats-entry-img" />}
                          {s.entry_name}
                        </td>
                        <td>{s.picks}</td>
                        <td>{pct(s.pick_rate)}</td>
                        <td>{s.bans}</td>
                        <td>{pct(s.ban_rate)}</td>
                        <td>{s.wins}</td>
                        <td>{s.losses}</td>
                        <td>{pct(s.win_rate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <p className="arena-back-link"><Link to="/arena/ranking">← ランキングに戻る</Link></p>
    </>
  )
}
