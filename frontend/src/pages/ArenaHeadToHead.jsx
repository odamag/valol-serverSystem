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

      {result && result.per_title.length > 0 && (
        <div className="card arena-card">
          <p className="arena-panel-title">タイトル別内訳（試合単位）</p>
          <div className="arena-table-wrap">
            <table className="arena-table">
              <thead>
                <tr>
                  <th>タイトル</th>
                  <th>{usernameOf(result.a)}</th>
                  <th>{usernameOf(result.b)}</th>
                  <th>試合数</th>
                </tr>
              </thead>
              <tbody>
                {result.per_title.map(g => (
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
          <p className="arena-panel-title">直近のシリーズ（5番勝負の内訳）</p>
          {result.series.length === 0 ? (
            <p className="arena-empty">まだ対戦記録がありません</p>
          ) : (
            <ul className="arena-h2h-match-list">
              {result.series.map(sr => {
                const aIsSideA = sr.side_a_user_id === result.a
                const aScore = aIsSideA ? sr.wins_a : sr.wins_b
                const bScore = aIsSideA ? sr.wins_b : sr.wins_a
                const aWon = sr.winner_id === result.a
                return (
                  <li key={sr.public_id} className="arena-h2h-match-item">
                    <div className="arena-h2h-match-head">
                      <span className={aWon ? 'arena-h2h-win' : 'arena-h2h-loss'}>
                        {usernameOf(aWon ? result.a : result.b)} の勝ち（{aScore} - {bScore}）
                      </span>
                      <span className="arena-h2h-match-date">{fmtDate(sr.finished_at)}</span>
                    </div>
                    <ol className="arena-h2h-games">
                      {sr.games.map(g => (
                        <li key={g.game_no}>
                          <span className="arena-lineup-no">第{g.game_no}</span>
                          <span>{g.game_icon || '🎮'} {g.game_name}</span>
                          {g.is_decider
                            ? <span className="arena-lineup-tag arena-lineup-tag--decider">Decider</span>
                            : <span className="arena-lineup-tag">PICK {g.picked_by}</span>}
                          <span className="arena-muted">
                            {g.winner_id === null ? '未実施' : `${usernameOf(g.winner_id)} の勝ち`}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <p className="arena-back-link"><Link to="/arena/ranking">← ランキングに戻る</Link></p>
    </>
  )
}
