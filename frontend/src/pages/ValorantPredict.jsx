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

function multColor(mult) {
  if (!mult) return 'var(--text-muted)'
  if (mult >= 5)  return '#f87171'
  if (mult >= 3)  return '#fb923c'
  if (mult >= 2)  return '#fbbf24'
  return '#4ade80'
}

// ─────────────────────────────────────────────────────────────────────────────
// 試合カード
// ─────────────────────────────────────────────────────────────────────────────
function MatchCard({ match, onVote, onResolve, voting, isLoggedIn }) {
  const {
    match_id, team1_name, team2_name, tournament, round_info,
    scheduled_at, team1_votes, team2_votes, total_votes,
    team1_multiplier, team2_multiplier, my_prediction, result, is_resolved, is_manual,
  } = match

  const isResolved = !!parseInt(is_resolved)
  const canVote    = isLoggedIn && !isResolved
  const p1 = pct(team1_votes, total_votes)
  const p2 = 100 - p1

  function teamClass(side) {
    const base = `predict-team-btn${my_prediction === side ? ' voted' : ''}`
    if (isResolved) return result === side ? base + ' result-win' : base + ' result-loss'
    return base
  }

  return (
    <div className={`predict-card val-card${isResolved ? ' predict-card--resolved' : ''}`}>
      {/* ヘッダー */}
      <div className="predict-card-header">
        <span className="val-tournament">{tournament || 'VALORANT'}</span>
        {round_info && <span className="val-round">{round_info}</span>}
        <span className="predict-time">{fmtDate(scheduled_at)}</span>
        {!!parseInt(is_manual) && <span className="val-manual-badge">手動</span>}
        {isResolved && <span className="predict-resolved-badge">確定</span>}
      </div>

      {/* チーム比較 */}
      <div className="predict-matchup">
        <div className="predict-side">
          <button
            className={teamClass('team1')}
            onClick={() => canVote && onVote(match_id, 'team1')}
            disabled={!canVote || voting === match_id}
          >
            <span className="predict-team-code">{team1_name}</span>
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

        <div className="predict-vs">VS</div>

        <div className="predict-side">
          <button
            className={teamClass('team2')}
            onClick={() => canVote && onVote(match_id, 'team2')}
            disabled={!canVote || voting === match_id}
          >
            <span className="predict-team-code">{team2_name}</span>
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
          <div className="predict-bar-fill val-bar-t1" style={{ width: `${p1}%` }} />
          <div className="predict-bar-fill val-bar-t2" style={{ width: `${p2}%` }} />
        </div>
      )}

      {/* フッター */}
      <div className="predict-card-footer">
        {!isLoggedIn && !isResolved && <span className="predict-hint">ログインして投票</span>}
        {isLoggedIn && !isResolved && !my_prediction && <span className="predict-hint">チームを選んで投票</span>}
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
          <span className="predict-hint">
            結果: {result === 'team1' ? team1_name : team2_name} 勝利
          </span>
        )}
        <span className="predict-total-votes">計 {total_votes} 票</span>

        {/* 手動結果確定ボタン（ログイン済み・未確定のみ） */}
        {isLoggedIn && !isResolved && onResolve && (
          <div className="val-resolve-btns">
            <button className="val-resolve-btn" onClick={() => onResolve(match_id, 'team1')}>
              {team1_name} 勝利
            </button>
            <button className="val-resolve-btn" onClick={() => onResolve(match_id, 'team2')}>
              {team2_name} 勝利
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 手動試合登録フォーム
// ─────────────────────────────────────────────────────────────────────────────
function AddMatchForm({ onAdded }) {
  const [form, setForm] = useState({
    team1: '', team2: '', tournament: '', round_info: '', scheduled_at: '',
  })
  const [loading, setLoading] = useState(false)
  const [msg,     setMsg]     = useState(null)

  function set(key, val) { setForm(f => ({ ...f, [key]: val })) }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.team1.trim() || !form.team2.trim()) return
    setLoading(true)
    setMsg(null)

    const schedTs = form.scheduled_at
      ? Math.floor(new Date(form.scheduled_at).getTime() / 1000)
      : null

    try {
      const res = await fetch('/api/valorant/predict.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add_match',
          team1:        form.team1.trim(),
          team2:        form.team2.trim(),
          tournament:   form.tournament.trim(),
          round_info:   form.round_info.trim(),
          scheduled_at: schedTs,
        }),
      })
      const d = await res.json()
      if (d.success) {
        setMsg({ type: 'ok', text: '試合を登録しました' })
        setForm({ team1: '', team2: '', tournament: '', round_info: '', scheduled_at: '' })
        onAdded()
      } else {
        setMsg({ type: 'err', text: d.message ?? 'エラーが発生しました' })
      }
    } catch {
      setMsg({ type: 'err', text: 'ネットワークエラーです' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="val-add-form" onSubmit={handleSubmit}>
      <h3 className="val-add-title">試合を手動登録</h3>
      {msg && (
        <div className={`val-add-msg ${msg.type === 'ok' ? 'ok' : 'err'}`}>{msg.text}</div>
      )}
      <div className="val-add-row">
        <input
          className="form-input val-add-input"
          placeholder="チーム1 *"
          value={form.team1}
          onChange={e => set('team1', e.target.value)}
          required
        />
        <span className="val-add-vs">vs</span>
        <input
          className="form-input val-add-input"
          placeholder="チーム2 *"
          value={form.team2}
          onChange={e => set('team2', e.target.value)}
          required
        />
      </div>
      <div className="val-add-row">
        <input
          className="form-input val-add-input"
          placeholder="大会名 (例: VCT 2025 Champions)"
          value={form.tournament}
          onChange={e => set('tournament', e.target.value)}
        />
        <input
          className="form-input val-add-input"
          placeholder="ラウンド (例: Grand Final)"
          value={form.round_info}
          onChange={e => set('round_info', e.target.value)}
        />
      </div>
      <div className="val-add-row">
        <input
          className="form-input val-add-input"
          type="datetime-local"
          value={form.scheduled_at}
          onChange={e => set('scheduled_at', e.target.value)}
        />
        <button className="val-add-submit" type="submit" disabled={loading}>
          {loading ? '登録中...' : '登録'}
        </button>
      </div>
    </form>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// リーダーボード
// ─────────────────────────────────────────────────────────────────────────────
function Leaderboard() {
  const [rankings, setRankings] = useState(null)
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    fetch('/api/valorant/predict.php?action=leaderboard', { credentials: 'include' })
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
            <th>順位</th><th>ユーザー</th><th>ポイント</th><th>的中率</th>
          </tr>
        </thead>
        <tbody>
          {rankings.map((r, i) => {
            const acc = r.total_preds > 0
              ? Math.round((r.correct_preds / r.total_preds) * 100) : 0
            return (
              <tr key={r.user_id} className={i < 3 ? 'lb-top' : ''}>
                <td className="lb-rank">{medals[i] ?? `${i + 1}位`}</td>
                <td className="lb-name">{r.username}</td>
                <td className="lb-points val-lb-points">{r.total_points.toLocaleString()} pt</td>
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
export default function ValorantPredict() {
  const { auth } = useAuth()
  const [tab,       setTab]       = useState('matches')
  const [matches,   setMatches]   = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [voting,    setVoting]    = useState(null)
  const [showAdmin,        setShowAdmin]        = useState(false)
  const [filterTournament, setFilterTournament] = useState('ALL')

  const loadMatches = useCallback(() => {
    setLoading(true)
    setError(null)
    fetch('/api/valorant/predict.php?action=matches', { credentials: 'include' })
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
      const res = await fetch('/api/valorant/predict.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'vote', match_id: matchId, prediction }),
      })
      const d = await res.json()
      if (d.success) {
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

  async function handleResolve(matchId, result) {
    const m = matches.find(x => x.match_id === matchId)
    const winner = result === 'team1' ? m?.team1_name : m?.team2_name
    if (!confirm(`「${winner}」の勝利として確定しますか？`)) return
    try {
      const res = await fetch('/api/valorant/predict.php', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', match_id: matchId, result }),
      })
      const d = await res.json()
      if (d.success) loadMatches()
      else alert(d.message ?? '確定に失敗しました')
    } catch {
      alert('ネットワークエラーです')
    }
  }

  const tournaments = matches
    ? ['ALL', ...new Set(matches.map(m => m.tournament).filter(Boolean))]
    : ['ALL']
  const filtered   = matches?.filter(m => filterTournament === 'ALL' || m.tournament === filterTournament) ?? []
  const pending    = filtered.filter(m => !parseInt(m.is_resolved))
  const resolved   = filtered.filter(m =>  parseInt(m.is_resolved))

  return (
    <div className="predict-page val-page">
      {/* ヘッダー */}
      <div className="predict-header val-header">
        <div className="val-title-row">
          <h1 className="predict-title">VALORANT 予測</h1>
          {auth.loggedIn && (
            <button
              className={`val-admin-toggle${showAdmin ? ' active' : ''}`}
              onClick={() => setShowAdmin(v => !v)}
            >
              ⚙ 管理
            </button>
          )}
        </div>
        <p className="predict-subtitle">
          少数派に投票するほど高倍率！アンダードッグを当てて大量ポイントを狙え
        </p>
      </div>

      {/* 管理パネル */}
      {auth.loggedIn && showAdmin && (
        <div className="val-admin-panel">
          <AddMatchForm onAdded={loadMatches} />
          <p className="val-admin-note">
            ※ vlrggapi から自動取得された試合は結果が出ると自動確定。<br />
            手動登録した試合は各カードの「勝利」ボタンで確定してください。
          </p>
        </div>
      )}

      {/* タブ */}
      <div className="predict-tabs">
        <button
          className={`predict-tab${tab === 'matches' ? ' active val-tab-active' : ''}`}
          onClick={() => setTab('matches')}
        >試合一覧</button>
        <button
          className={`predict-tab${tab === 'ranking' ? ' active val-tab-active' : ''}`}
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
              {tournaments.length > 2 && (
                <div className="predict-league-filters">
                  {tournaments.map(t => (
                    <button
                      key={t}
                      className={`predict-league-btn${filterTournament === t ? ' active' : ''}`}
                      onClick={() => setFilterTournament(t)}
                    >
                      {t === 'ALL' ? 'すべて' : t}
                    </button>
                  ))}
                </div>
              )}

              {pending.length === 0 && resolved.length === 0 && (
                <div className="predict-empty">
                  現在予測できる試合はありません
                  {auth.loggedIn && ' — 管理パネルから手動登録できます'}
                </div>
              )}

              {pending.length > 0 && (
                <section>
                  <h2 className="predict-section-title">開催予定・進行中</h2>
                  <div className="predict-list">
                    {pending.map(m => (
                      <MatchCard
                        key={m.match_id}
                        match={m}
                        onVote={handleVote}
                        onResolve={auth.loggedIn && showAdmin ? handleResolve : null}
                        voting={voting}
                        isLoggedIn={auth.loggedIn}
                      />
                    ))}
                  </div>
                </section>
              )}

              {resolved.length > 0 && (
                <section>
                  <h2 className="predict-section-title">結果確定</h2>
                  <div className="predict-list">
                    {resolved.map(m => (
                      <MatchCard
                        key={m.match_id}
                        match={m}
                        onVote={handleVote}
                        onResolve={null}
                        voting={voting}
                        isLoggedIn={auth.loggedIn}
                      />
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
