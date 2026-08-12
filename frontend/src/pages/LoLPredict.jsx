import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../App.jsx'

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '日時未定'
  const d = new Date(ts * 1000)
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short' })
       + ' ' + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function pct(part, total) {
  if (!total) return 50
  return Math.round((part / total) * 100)
}

// 倍率に応じた色
function multColor(mult) {
  if (!mult) return 'var(--text-muted)'
  if (mult >= 5)  return '#f87171'  // 赤：超アンダードッグ
  if (mult >= 3)  return '#fb923c'  // オレンジ
  if (mult >= 2)  return '#fbbf24'  // 黄
  return 'var(--success)'           // 緑：人気チーム
}

// ─────────────────────────────────────────────────────────────────────────────
// 試合カード
// ─────────────────────────────────────────────────────────────────────────────
function MatchCard({ match, onVote, voting }) {
  const { auth } = useAuth()
  const {
    match_id, team1_name, team2_name, team1_code, team2_code,
    league_name, scheduled_at,
    team1_votes, team2_votes, total_votes,
    team1_multiplier, team2_multiplier,
    my_prediction, result, is_resolved,
  } = match

  const p1 = pct(team1_votes, total_votes)
  const p2 = 100 - p1

  const isResolved = !!parseInt(is_resolved)
  const canVote    = auth.loggedIn && !isResolved

  function teamClass(side) {
    const base = `predict-team-btn${my_prediction === side ? ' voted' : ''}`
    if (isResolved) {
      return result === side ? base + ' result-win' : base + ' result-loss'
    }
    return base
  }

  return (
    <div className={`predict-card${isResolved ? ' predict-card--resolved' : ''}`}>
      {/* ヘッダー */}
      <div className="predict-card-header">
        <span className="predict-league">{league_name || 'eSports'}</span>
        <span className="predict-time">{fmtDate(scheduled_at)}</span>
        {isResolved && <span className="predict-resolved-badge">確定</span>}
      </div>

      {/* チーム比較 */}
      <div className="predict-matchup">
        {/* チーム1 */}
        <div className="predict-side">
          <button
            className={teamClass('team1')}
            onClick={() => canVote && onVote(match_id, 'team1')}
            disabled={!canVote || voting === match_id}
          >
            <span className="predict-team-code">{team1_code || team1_name}</span>
            <span className="predict-team-name">{team1_name}</span>
            {team1_multiplier && (
              <span className="predict-mult" style={{ color: multColor(team1_multiplier) }}>
                ×{team1_multiplier}
              </span>
            )}
            {!team1_multiplier && !isResolved && (
              <span className="predict-mult-first">先着ボーナス!</span>
            )}
          </button>
          <div className="predict-vote-count">{team1_votes}票 ({p1}%)</div>
        </div>

        {/* VS */}
        <div className="predict-vs">VS</div>

        {/* チーム2 */}
        <div className="predict-side">
          <button
            className={teamClass('team2')}
            onClick={() => canVote && onVote(match_id, 'team2')}
            disabled={!canVote || voting === match_id}
          >
            <span className="predict-team-code">{team2_code || team2_name}</span>
            <span className="predict-team-name">{team2_name}</span>
            {team2_multiplier && (
              <span className="predict-mult" style={{ color: multColor(team2_multiplier) }}>
                ×{team2_multiplier}
              </span>
            )}
            {!team2_multiplier && !isResolved && (
              <span className="predict-mult-first">先着ボーナス!</span>
            )}
          </button>
          <div className="predict-vote-count">{team2_votes}票 ({p2}%)</div>
        </div>
      </div>

      {/* 投票バー */}
      {total_votes > 0 && (
        <div className="predict-bar-wrap">
          <div
            className="predict-bar-fill predict-bar-t1"
            style={{ width: `${p1}%` }}
          />
          <div
            className="predict-bar-fill predict-bar-t2"
            style={{ width: `${p2}%` }}
          />
        </div>
      )}

      {/* フッター */}
      <div className="predict-card-footer">
        {!auth.loggedIn && !isResolved && (
          <span className="predict-hint">ログインして投票</span>
        )}
        {auth.loggedIn && !isResolved && !my_prediction && (
          <span className="predict-hint">チームを選んで投票</span>
        )}
        {my_prediction && !isResolved && (
          <span className="predict-my-vote">
            あなたの予想: {my_prediction === 'team1' ? team1_name : team2_name}
          </span>
        )}
        {isResolved && my_prediction && (
          <span className={`predict-result-msg ${my_prediction === result ? 'correct' : 'wrong'}`}>
            {my_prediction === result ? '✓ 正解！ポイント獲得' : '✗ 外れ…'}
          </span>
        )}
        {isResolved && !my_prediction && (
          <span className="predict-hint">投票なし（結果: {result === 'team1' ? team1_name : team2_name} 勝利）</span>
        )}
        <span className="predict-total-votes">計 {total_votes} 票</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// リーダーボード
// ─────────────────────────────────────────────────────────────────────────────
function Leaderboard() {
  const [rankings, setRankings] = useState(null)
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    fetch('/api/lol/predict.php?action=leaderboard', { credentials: 'include' })
      .then(r => r.json())
      .then(d => setRankings(d.rankings ?? []))
      .catch(() => setRankings([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="predict-loading">読み込み中...</div>
  if (!rankings.length) return <div className="predict-empty">まだ記録がありません</div>

  const medals = ['🥇', '🥈', '🥉']

  return (
    <div className="predict-leaderboard">
      <table className="predict-lb-table">
        <thead>
          <tr>
            <th>順位</th>
            <th>ユーザー</th>
            <th>ポイント</th>
            <th>的中率</th>
          </tr>
        </thead>
        <tbody>
          {rankings.map((r, i) => {
            const acc = r.total_preds > 0
              ? Math.round((r.correct_preds / r.total_preds) * 100)
              : 0
            return (
              <tr key={r.user_id} className={i < 3 ? 'lb-top' : ''}>
                <td className="lb-rank">
                  {medals[i] ?? `${i + 1}位`}
                </td>
                <td className="lb-name">{r.username}</td>
                <td className="lb-points">{r.total_points.toLocaleString()} pt</td>
                <td className="lb-acc">
                  {r.correct_preds}/{r.total_preds}
                  <span className="lb-acc-pct"> ({acc}%)</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// メインページ
// ─────────────────────────────────────────────────────────────────────────────
export default function LoLPredict() {
  const [tab,     setTab]     = useState('matches')
  const [matches, setMatches] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [voting,  setVoting]  = useState(null)   // 投票中のmatch_id
  const [league,  setLeague]  = useState('ALL')  // リーグフィルター

  const loadMatches = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/lol/predict.php?action=matches', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (d.success) setMatches(d.matches)
        else setError(d.message ?? 'エラーが発生しました')
      })
      .catch(() => setError('ネットワークエラーです'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadMatches() }, [loadMatches])

  async function handleVote(matchId, prediction) {
    setVoting(matchId)
    try {
      const res = await fetch('/api/lol/predict.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vote', match_id: matchId, prediction }),
      })
      const d = await res.json()
      if (d.success) {
        // 楽観的更新: 投票結果を即時反映
        setMatches(prev => prev.map(m => {
          if (m.match_id !== matchId) return m
          const old = m.my_prediction
          const v1  = m.team1_votes + (prediction === 'team1' ? 1 : 0) - (old === 'team1' ? 1 : 0)
          const v2  = m.team2_votes + (prediction === 'team2' ? 1 : 0) - (old === 'team2' ? 1 : 0)
          const tot = v1 + v2
          return {
            ...m,
            my_prediction:    prediction,
            team1_votes:      v1,
            team2_votes:      v2,
            total_votes:      tot,
            team1_multiplier: v1 > 0 ? Math.round((tot / v1) * 10) / 10 : null,
            team2_multiplier: v2 > 0 ? Math.round((tot / v2) * 10) / 10 : null,
          }
        }))
      } else {
        alert(d.message ?? '投票に失敗しました')
      }
    } catch {
      alert('ネットワークエラーです')
    } finally {
      setVoting(null)
    }
  }

  // 取得済み試合から重複なしリーグ一覧を生成
  const leagues = matches
    ? ['ALL', ...new Set(matches.map(m => m.league_name).filter(Boolean))]
    : ['ALL']

  const filtered = matches?.filter(m => league === 'ALL' || m.league_name === league) ?? []
  const pending  = filtered.filter(m => !parseInt(m.is_resolved))
  const resolved = filtered.filter(m =>  parseInt(m.is_resolved))

  return (
    <div className="predict-page">
      <div className="predict-header">
        <h1 className="predict-title">LoL eSports 予測</h1>
        <p className="predict-subtitle">
          少数派に投票するほど高倍率！アンダードッグを当てて大量ポイントを狙え
        </p>
      </div>

      {/* タブ */}
      <div className="predict-tabs">
        <button
          className={`predict-tab${tab === 'matches' ? ' active' : ''}`}
          onClick={() => setTab('matches')}
        >試合一覧</button>
        <button
          className={`predict-tab${tab === 'ranking' ? ' active' : ''}`}
          onClick={() => setTab('ranking')}
        >ランキング</button>
      </div>

      {tab === 'matches' && (
        <>
          {loading && <div className="predict-loading">試合データを取得中...</div>}
          {error   && (
            <div className="predict-error">
              <p>{error}</p>
              <button className="predict-retry-btn" onClick={loadMatches}>再試行</button>
            </div>
          )}
          {!loading && !error && matches !== null && (
            <>
              {/* リーグフィルター */}
              {leagues.length > 2 && (
                <div className="predict-league-filters">
                  {leagues.map(lg => (
                    <button
                      key={lg}
                      className={`predict-league-btn${league === lg ? ' active' : ''}`}
                      onClick={() => setLeague(lg)}
                    >
                      {lg === 'ALL' ? 'すべて' : lg}
                    </button>
                  ))}
                </div>
              )}

              {pending.length === 0 && resolved.length === 0 && (
                <div className="predict-empty">
                  {league === 'ALL' ? '現在予測できる試合はありません' : `${league} の試合はありません`}
                </div>
              )}

              {pending.length > 0 && (
                <section>
                  <h2 className="predict-section-title">開催予定・進行中</h2>
                  <div className="predict-list">
                    {pending.map(m => (
                      <MatchCard key={m.match_id} match={m} onVote={handleVote} voting={voting} />
                    ))}
                  </div>
                </section>
              )}

              {resolved.length > 0 && (
                <section>
                  <h2 className="predict-section-title">結果確定</h2>
                  <div className="predict-list">
                    {resolved.map(m => (
                      <MatchCard key={m.match_id} match={m} onVote={handleVote} voting={voting} />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </>
      )}

      {tab === 'ranking' && <Leaderboard />}
    </div>
  )
}
