import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import runningApi, { RunningApiError } from '../lib/runningApi.js'
import { formatDuration } from '../lib/runningFormat.js'

function errMsg(e) {
  return e instanceof RunningApiError ? e.message : '通信エラーが発生しました'
}

// JST の当月を "YYYY-MM" で返す
function currentMonthJst() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// "YYYY-MM" に月差分を加える（マイナスで過去へ）
function addMonths(ym, diff) {
  const [y, m] = ym.split('-').map(Number)
  const total = y * 12 + (m - 1) + diff
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}`
}

const SCOPES = [
  { value: 'month', label: '月間' },
  { value: 'week', label: '週間' },
  { value: 'total', label: '通算' },
]

const MEDALS = ['🥇', '🥈', '🥉']

export default function RunningRanking() {
  const [scope, setScope] = useState('month')
  const [period, setPeriod] = useState(currentMonthJst())
  const [entries, setEntries] = useState([])
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [discordRequired, setDiscordRequired] = useState(false)

  // 当月より先へは進めない（文字列のまま比較しても "YYYY-MM" は辞書順で日付順になる）
  const atCurrentMonth = period >= currentMonthJst()

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    setDiscordRequired(false)
    let path = `/v1/ranking?scope=${scope}&limit=20`
    if (scope === 'month') path += `&period=${period}`
    runningApi.get(path)
      .then(d => { setEntries(d.entries || []); setMe(d.me || null) })
      .catch(e => {
        if (e instanceof RunningApiError && e.status === 403) setDiscordRequired(true)
        else setError(errMsg(e))
      })
      .finally(() => setLoading(false))
  }, [scope, period])

  useEffect(() => { load() }, [load])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 ランニングランキング</h1>
        <p className="page-subtitle">月間・週間・通算の走行距離ランキング</p>
      </div>

      {!loading && discordRequired && (
        <div className="card running-card">
          <div className="alert alert-error">
            ランニング機能を使うには Discord でログインしてください。
          </div>
          <Link to="/login" className="btn btn-secondary">ログインページへ</Link>
        </div>
      )}

      {!discordRequired && (
        <div className="card running-card">
          <div className="running-scope-tabs">
            {SCOPES.map(s => (
              <button
                key={s.value}
                className={`running-tab${scope === s.value ? ' running-tab--active' : ''}`}
                onClick={() => setScope(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>

          {scope === 'month' && (
            <div className="running-period-nav">
              <button className="btn btn-secondary running-inline-btn" onClick={() => setPeriod(p => addMonths(p, -1))}>
                ← 前月
              </button>
              <span className="running-period-label">{period}</span>
              <button
                className="btn btn-secondary running-inline-btn"
                onClick={() => setPeriod(p => addMonths(p, 1))}
                disabled={atCurrentMonth}
              >
                翌月 →
              </button>
            </div>
          )}

          {error && <p className="running-error">{error}</p>}

          {!loading && !error && (
            me ? (
              <p className="running-me-rank">
                あなた: <strong>{me.rank}位</strong> {me.distanceKm}km
              </p>
            ) : (
              <p className="running-me-rank running-muted">まだ順位がありません</p>
            )
          )}

          {loading ? (
            <p className="running-loading">読み込み中…</p>
          ) : entries.length === 0 ? (
            <p className="running-empty">まだ記録がありません</p>
          ) : (
            <div className="running-table-wrap">
              <table className="running-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>名前</th>
                    <th>距離</th>
                    <th>回数</th>
                    <th>時間</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => (
                    <tr key={e.discordId}>
                      <td>{e.rank <= 3 ? MEDALS[e.rank - 1] : e.rank}</td>
                      <td>{e.userName}</td>
                      <td>{e.distanceKm}km</td>
                      <td>{e.runs}回</td>
                      <td>{formatDuration(e.durationS)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <Link to="/running" className="btn btn-secondary running-back">← ランニングトップへ</Link>
    </>
  )
}
