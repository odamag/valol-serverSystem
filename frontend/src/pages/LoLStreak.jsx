import { useState, useEffect, useCallback } from 'react'

const DDragon = 'https://ddragon.leagueoflegends.com'

const TIER_ORDER = { IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4, EMERALD: 5, DIAMOND: 6, MASTER: 7, GRANDMASTER: 8, CHALLENGER: 9 }
const RANK_ORDER = { IV: 0, III: 1, II: 2, I: 3 }
const TIER_COLOR = {
  IRON: '#8d7b6b', BRONZE: '#cd7f32', SILVER: '#94a3b8', GOLD: '#f59e0b',
  PLATINUM: '#22d3ee', EMERALD: '#10b981', DIAMOND: '#818cf8',
  MASTER: '#c084fc', GRANDMASTER: '#f87171', CHALLENGER: '#fbbf24',
}
const TIER_JP = {
  IRON: 'アイアン', BRONZE: 'ブロンズ', SILVER: 'シルバー', GOLD: 'ゴールド',
  PLATINUM: 'プラチナ', EMERALD: 'エメラルド', DIAMOND: 'ダイヤ',
  MASTER: 'マスター', GRANDMASTER: 'GM', CHALLENGER: 'チャレ',
}
const NO_DIVISION = ['MASTER', 'GRANDMASTER', 'CHALLENGER']

function rankScore(rank) {
  if (!rank) return -1
  return (TIER_ORDER[rank.tier] ?? 0) * 10000 + (RANK_ORDER[rank.rank] ?? 0) * 1000 + rank.lp
}

function winRate(rank) {
  const total = rank.wins + rank.losses
  return total === 0 ? 0 : Math.round((rank.wins / total) * 100)
}

function timeAgo(timestamp) {
  if (!timestamp) return null
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'たった今'
  if (mins < 60) return `${mins}分前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}時間前`
  const days = Math.floor(hours / 24)
  return `${days}日前`
}

function RankBadge({ rank, small = false }) {
  if (!rank) return <span className="rank-badge-unranked">未ランク</span>
  const color = TIER_COLOR[rank.tier] ?? '#94a3b8'
  const label = NO_DIVISION.includes(rank.tier)
    ? TIER_JP[rank.tier]
    : `${TIER_JP[rank.tier]} ${rank.rank}`
  return (
    <span
      className={`rank-badge${small ? ' rank-badge-sm' : ''}`}
      style={{ color, borderColor: `${color}55`, background: `${color}18` }}
    >
      {label}
    </span>
  )
}

function StreakBadge({ streak }) {
  if (streak === 0) {
    return <div className="streak-badge streak-none">ランク試合なし</div>
  }
  const isWin = streak > 0
  const count = Math.abs(streak)
  const emoji = isWin
    ? count >= 5 ? '🔥🔥' : count >= 3 ? '🔥' : '⚡'
    : count >= 5 ? '💀💀' : count >= 3 ? '💀' : '❄️'
  return (
    <div className={`streak-badge ${isWin ? 'streak-win' : 'streak-loss'}${count >= 3 ? ' streak-hot' : ''}`}>
      <span className="streak-count">{count}</span>
      <span className="streak-label">{isWin ? '連勝' : '連敗'}</span>
      <span className="streak-emoji">{emoji}</span>
    </div>
  )
}

function MatchDot({ match }) {
  return (
    <div
      className={`match-dot ${match.win ? 'match-win' : 'match-loss'}`}
      title={`${match.champion}  ${match.kills}/${match.deaths}/${match.assists}`}
    />
  )
}

export default function LoLStreak() {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [version, setVersion] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [streakRes, versions] = await Promise.all([
        fetch('/api/lol/streak.php').then(r => {
          if (!r.ok) throw new Error('API error')
          return r.json()
        }),
        fetch(`${DDragon}/api/versions.json`).then(r => r.json()),
      ])
      setData(streakRes)
      setVersion(versions[0])
      setLastUpdated(new Date())
    } catch {
      setError('データの取得に失敗しました。しばらくしてから再試行してください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ランクでソート（ソロ優先、なければフレックス）
  const rankedByRank = [...data]
    .filter(p => !p.error)
    .sort((a, b) => {
      const sa = rankScore(a.soloRank ?? a.flexRank)
      const sb = rankScore(b.soloRank ?? b.flexRank)
      return sb - sa
    })

  return (
    <div>
      <div className="page-header">
        <div className="streak-page-header">
          <div>
            <h1 className="page-title">🏆 LoL 戦績</h1>
            <p className="page-subtitle">
              {lastUpdated
                ? `最終更新: ${lastUpdated.toLocaleTimeString('ja-JP')} （キャッシュ5分）`
                : 'ランクの連勝・連敗ストリークを表示します'}
            </p>
          </div>
          <button
            className="btn btn-secondary streak-refresh-btn"
            onClick={fetchData}
            disabled={loading}
          >
            {loading ? '読み込み中...' : '🔄 更新'}
          </button>
        </div>
      </div>

      {loading && (
        <div className="lol-loading">
          <div className="loading-spinner" />
          <p>戦績を取得中...</p>
          <p className="page-subtitle" style={{ fontSize: '0.8rem', marginTop: 4 }}>
            Riot API に問い合わせています。少々お待ちください。
          </p>
        </div>
      )}

      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && data.length === 0 && (
        <div className="lol-empty">
          メンバーが登録されていません。<br />
          <span style={{ fontSize: '0.85rem' }}>api/lol/config.php の members にRiot IDを追加してください。</span>
        </div>
      )}

      {!loading && !error && data.length > 0 && (
        <>
          {/* 連勝/連敗カード */}
          <div className="streak-grid">
            {data.map(player => (
              <div
                key={`${player.name}#${player.tag}`}
                className={`streak-card${player.streak > 0 ? ' streak-card-win' : player.streak < 0 ? ' streak-card-loss' : ''}`}
              >
                {player.error ? (
                  <div className="streak-error-content">
                    <div className="streak-player-name">
                      {player.name}<span className="streak-tag">#{player.tag}</span>
                    </div>
                    <div className="streak-badge streak-none">{player.error}</div>
                  </div>
                ) : (
                  <>
                    <div className="streak-card-top">
                      {player.lastChampion && version ? (
                        <img
                          className="streak-champ-icon"
                          src={`${DDragon}/cdn/${version}/img/champion/${player.lastChampion}.png`}
                          alt={player.lastChampion}
                        />
                      ) : (
                        <div className="streak-champ-placeholder">?</div>
                      )}
                      <div className="streak-player-info">
                        <div className="streak-player-name">
                          {player.name}<span className="streak-tag">#{player.tag}</span>
                        </div>
                        {player.soloRank && (
                          <div style={{ marginTop: 3 }}>
                            <RankBadge rank={player.soloRank} small />
                          </div>
                        )}
                        {player.lastMatchTime && (
                          <div className="streak-time">{timeAgo(player.lastMatchTime)}</div>
                        )}
                      </div>
                    </div>

                    <StreakBadge streak={player.streak} />

                    {player.recentMatches.length > 0 && (
                      <div className="streak-recent">
                        <span className="streak-recent-label">直近</span>
                        <div className="streak-dots">
                          {player.recentMatches.map((m, i) => (
                            <MatchDot key={i} match={m} />
                          ))}
                        </div>
                        <div className="streak-kda">
                          {player.recentMatches[0].kills}/
                          {player.recentMatches[0].deaths}/
                          {player.recentMatches[0].assists}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* ランクランキング */}
          {rankedByRank.length > 0 && (
            <div className="rank-section">
              <h2 className="rank-section-title">ランクランキング</h2>
              <div className="rank-table">
                {rankedByRank.map((player, i) => {
                  const primary = player.soloRank ?? player.flexRank
                  const isFlexOnly = !player.soloRank && player.flexRank
                  const wr = primary ? winRate(primary) : null
                  return (
                    <div key={`${player.name}#${player.tag}`} className="rank-row">
                      <span className={`rank-position rank-pos-${i + 1}`}>
                        {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}位`}
                      </span>

                      <div className="rank-tier-cell">
                        <RankBadge rank={primary} />
                        {isFlexOnly && (
                          <span className="rank-queue-note">フレックス</span>
                        )}
                      </div>

                      <div className="rank-name-cell">
                        <span className="rank-player-name">{player.name}</span>
                        <span className="rank-tag">#{player.tag}</span>
                      </div>

                      {primary ? (
                        <>
                          <span className="rank-lp">{primary.lp} LP</span>
                          <span className="rank-record">
                            {primary.wins}W {primary.losses}L
                          </span>
                          <span
                            className="rank-winrate"
                            style={{ color: wr >= 55 ? '#34d399' : wr <= 45 ? '#f87171' : 'var(--text-muted)' }}
                          >
                            {wr}%
                          </span>
                        </>
                      ) : (
                        <span className="rank-unranked-note" style={{ gridColumn: 'span 3' }}>
                          未ランク
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
