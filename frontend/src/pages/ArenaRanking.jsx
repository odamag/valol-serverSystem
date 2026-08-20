import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

function pct(v) {
  return v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`
}

export default function ArenaRanking() {
  const [games, setGames] = useState([])
  // scope は 'overall' | 'series' | タイトルの slug
  const [scope, setScope] = useState('overall')
  const [ranking, setRanking] = useState([])
  const [season, setSeason] = useState(null)
  const [stats, setStats] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    arenaApi.get('/v1/games')
      .then(d => setGames(d.games || []))
      .catch(e => setError(errMsg(e)))
  }, [])

  useEffect(() => {
    setLoading(true)
    arenaApi.get(`/v1/ranking?game=${encodeURIComponent(scope)}`)
      .then(d => { setRanking(d.ranking || []); setSeason(d.season || null); setError(null) })
      .catch(e => setError(errMsg(e)))
      .finally(() => setLoading(false))
  }, [scope])

  useEffect(() => {
    arenaApi.get('/v1/title-stats')
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏆 ランキング</h1>
        <p className="page-subtitle">
          タイトル別・総合・シリーズ（5番勝負）別のレーティング
          {season && `　|　${season.name}（配置 ${season.placement_games} 戦）`}
        </p>
      </div>

      {error && <p className="arena-error">{error}</p>}

      <div className="card arena-card">
        <div className="arena-scope-tabs">
          <button className={`arena-mode-tab${scope === 'overall' ? ' active' : ''}`}
                  onClick={() => setScope('overall')}>総合</button>
          <button className={`arena-mode-tab${scope === 'series' ? ' active' : ''}`}
                  onClick={() => setScope('series')}>シリーズ</button>
          {games.map(g => (
            <button key={g.slug}
                    className={`arena-mode-tab${scope === g.slug ? ' active' : ''}`}
                    onClick={() => setScope(g.slug)}>
              {g.icon || ''} {g.name}
            </button>
          ))}
        </div>

        {season && ranking.some(r => r.in_placement) && (
          <p className="arena-muted arena-placement-note">
            配置期間中のプレイヤーはランクが確定していません。
            {season.placement_games} 戦こなすまで、表示ランクは内部レートより最大 {season.offset_max} 低く抑えられます。
          </p>
        )}

        {loading ? <p className="arena-loading">読み込み中…</p> : (
          ranking.length === 0
            ? <p className="arena-muted">まだ記録がありません。</p>
            : (
              <div className="arena-table-wrap">
                <table className="arena-table">
                  <thead>
                    <tr><th>#</th><th>プレイヤー</th><th>ランク</th><th>勝敗</th><th>連勝</th><th>最高</th></tr>
                  </thead>
                  <tbody>
                    {ranking.map(r => (
                      <tr key={r.user_id} className={r.in_placement ? 'arena-row-placement' : ''}>
                        <td>{r.rank}</td>
                        <td><Link to={`/arena/head-to-head?a=${r.user_id}`}>{r.username}</Link></td>
                        <td>
                          {r.in_placement ? (
                            // 配置期間中は数値を出さない（確定していないランクを見せない）
                            <span className="arena-placement-chip">
                              配置中（残り{r.placement_remaining}戦）
                            </span>
                          ) : (
                            <strong>{r.display_rating}</strong>
                          )}
                        </td>
                        <td>{r.wins}勝 {r.losses}敗</td>
                        <td>{r.streak > 0 ? `${r.streak}連勝` : r.streak < 0 ? `${-r.streak}連敗` : '—'}</td>
                        <td className="arena-muted">{r.in_placement ? '—' : r.peak_rating}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>

      {stats && stats.stats.length > 0 && (
        <div className="card arena-card">
          <h2 className="arena-section-title">タイトル別の傾向</h2>
          <p className="arena-muted">全 {stats.total_series} シリーズが対象</p>
          <div className="arena-table-wrap">
            <table className="arena-table">
              <thead>
                <tr><th>タイトル</th><th>BAN</th><th>PICK</th><th>Decider</th><th>BAN率</th><th>PICK率</th><th>実施</th></tr>
              </thead>
              <tbody>
                {stats.stats.map(s => (
                  <tr key={s.game_id}>
                    <td>{s.game_icon} {s.game_name}</td>
                    <td>{s.bans}</td>
                    <td>{s.picks}</td>
                    <td>{s.deciders}</td>
                    <td>{pct(s.ban_rate)}</td>
                    <td>{pct(s.pick_rate)}</td>
                    <td>{s.played}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Link to="/arena" className="btn btn-secondary arena-back">← バンピックトップへ</Link>
    </>
  )
}
