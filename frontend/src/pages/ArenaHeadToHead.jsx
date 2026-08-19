import { useState, useEffect, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

function fmtDate(ts) {
  if (!ts) return ''
  return new Date(ts * 1000).toLocaleString('ja-JP')
}

// ヘッドトゥヘッド詳細：通算成績・ゲーム別内訳・現在のストリーク・直近試合ごとのBAN/PICK内訳。
export default function ArenaHeadToHead() {
  const [searchParams, setSearchParams] = useSearchParams()
  const a = searchParams.get('a') || ''
  const b = searchParams.get('b') || ''

  const [users, setUsers] = useState([])
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    arenaApi.get('/v1/users').then(data => setUsers(data.users)).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!a || !b || a === b) {
      setResult(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await arenaApi.get(`/v1/head-to-head?a=${a}&b=${b}`)
      setResult(data)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [a, b])

  useEffect(() => { load() }, [load])

  function usernameOf(id) {
    const u = users.find(u => String(u.id) === String(id))
    return u ? u.username : `#${id}`
  }

  function handleSelect(which, value) {
    const next = new URLSearchParams(searchParams)
    if (value) {
      next.set(which, value)
    } else {
      next.delete(which)
    }
    setSearchParams(next)
  }

  const streakLabel = result && result.streak.side && result.streak.count > 0
    ? `${usernameOf(result.streak.side === 'a' ? result.a : result.b)} の${result.streak.count}連勝`
    : '対戦記録なし'

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">⚔️ ヘッドトゥヘッド</h1>
        <p className="page-subtitle">2人のプレイヤーの直接対決の成績です</p>
      </div>

      <div className="card arena-card">
        <div className="arena-h2h-form">
          <select className="form-input" value={a} onChange={e => handleSelect('a', e.target.value)}>
            <option value="">プレイヤーA</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
          <span>vs</span>
          <select className="form-input" value={b} onChange={e => handleSelect('b', e.target.value)}>
            <option value="">プレイヤーB</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
        </div>

        {a && b && a === b && <p className="arena-msg arena-msg--err">異なる2人を選んでください</p>}
        {loading && <p className="arena-loading">読み込み中…</p>}
        {error && <p className="arena-msg arena-msg--err">{error}</p>}

        {result && (
          <>
            <p className="arena-h2h-result arena-h2h-result--big">
              {usernameOf(result.a)} <strong>{result.a_wins}</strong> - <strong>{result.b_wins}</strong> {usernameOf(result.b)}
              {' '}（全 {result.total} 戦）
            </p>
            <p className="arena-msg">現在のストリーク: {streakLabel}</p>
          </>
        )}
      </div>

      {result && result.per_game.length > 0 && (
        <div className="card arena-card">
          <p className="arena-panel-title">ゲーム別内訳</p>
          <div className="arena-table-wrap">
            <table className="arena-ranking-table">
              <thead>
                <tr>
                  <th>ゲーム</th>
                  <th>{usernameOf(result.a)}</th>
                  <th>{usernameOf(result.b)}</th>
                  <th>対戦数</th>
                </tr>
              </thead>
              <tbody>
                {result.per_game.map(g => (
                  <tr key={g.game_slug}>
                    <td>{g.game_icon || '🎮'} {g.game_name}</td>
                    <td>{g.a_wins}</td>
                    <td>{g.b_wins}</td>
                    <td>{g.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <div className="card arena-card">
          <p className="arena-panel-title">直近の対戦（BAN/PICK内訳）</p>
          {result.matches.length === 0 ? (
            <p className="arena-empty">まだ対戦記録がありません</p>
          ) : (
            <ul className="arena-h2h-match-list">
              {result.matches.map(m => (
                <li key={m.public_id} className="arena-h2h-match-item">
                  <div className="arena-h2h-match-head">
                    <span>{m.game_icon || '🎮'} {m.game_name}</span>
                    <span className={m.a_won ? 'arena-h2h-win' : 'arena-h2h-loss'}>
                      {usernameOf(m.a_won ? result.a : result.b)} の勝ち（{m.score_a} - {m.score_b}）
                    </span>
                    <span className="arena-h2h-match-date">{fmtDate(m.finished_at)}</span>
                    {m.series_id && <span className="arena-badge arena-badge--muted">シリーズ戦</span>}
                  </div>
                  <div className="arena-h2h-picks">
                    <div>
                      <span className="arena-h2h-picks-label">{usernameOf(result.a)}のPICK:</span>
                      {m.a_picks.length === 0 ? <span className="arena-empty-inline">-</span> : m.a_picks.map(p => (
                        <span key={p.entry_id} className="arena-pick-chip">{p.name}</span>
                      ))}
                    </div>
                    <div>
                      <span className="arena-h2h-picks-label">{usernameOf(result.b)}のPICK:</span>
                      {m.b_picks.length === 0 ? <span className="arena-empty-inline">-</span> : m.b_picks.map(p => (
                        <span key={p.entry_id} className="arena-pick-chip">{p.name}</span>
                      ))}
                    </div>
                    {m.bans.length > 0 && (
                      <div>
                        <span className="arena-h2h-picks-label">BAN:</span>
                        {m.bans.map((p, i) => (
                          <span key={p.entry_id + '-' + i} className="arena-ban-chip">{p.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="arena-back-link"><Link to="/arena/ranking">← ランキングに戻る</Link></p>
    </>
  )
}
