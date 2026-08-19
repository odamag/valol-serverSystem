import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'
import { useAuth } from '../App.jsx'

const STATUS_LABEL = {
  waiting: '対戦相手待ち',
  drafting: 'ドラフト中',
  playing: '対戦中',
  reported: '結果申告中',
  finished: '確定',
  cancelled: '中止',
}

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

// 試合詳細：ドラフトへの導線、結果申告、相手による承認、レート増減の表示。
export default function ArenaMatch() {
  const { publicId } = useParams()
  const navigate = useNavigate()
  const { auth } = useAuth()
  const [match, setMatch] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [nextGameError, setNextGameError] = useState(null)

  const [winner, setWinner] = useState('A')
  const [scoreA, setScoreA] = useState('0')
  const [scoreB, setScoreB] = useState('0')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await arenaApi.get(`/v1/matches/${publicId}`)
      setMatch(data.match)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [publicId])

  useEffect(() => { load() }, [load])

  async function handleReport(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const data = await arenaApi.post(`/v1/matches/${publicId}/result`, {
        winner,
        score_a: Number(scoreA) || 0,
        score_b: Number(scoreB) || 0,
      })
      setMatch(data.match)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    try {
      const data = await arenaApi.post(`/v1/matches/${publicId}/confirm`)
      setMatch(data.match)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleStartNextGame() {
    if (!match || !match.series_id) return
    setBusy(true)
    setNextGameError(null)
    try {
      const data = await arenaApi.post('/v1/matches', { series_id: match.series_id })
      navigate(`/arena/draft/${data.match.public_id}`)
    } catch (e) {
      setNextGameError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleCancel() {
    if (!confirm('この試合を中止しますか？')) return
    setBusy(true)
    setError(null)
    try {
      const data = await arenaApi.post(`/v1/matches/${publicId}/cancel`)
      setMatch(data.match)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="arena-loading">読み込み中…</p>
  if (error && !match) return <p className="arena-msg arena-msg--err">{error}</p>
  if (!match) return null

  const isReporter = match.reported_by === auth.userId
  const canReport = match.status === 'playing' || (match.status === 'reported' && isReporter)
  const canConfirm = match.status === 'reported' && !isReporter
  const canCancel = ['waiting', 'drafting', 'playing'].includes(match.status)
  const myDelta = match.rating_deltas ? match.rating_deltas[auth.userId] : null
  const reporterName = match.reported_by === match.player_a_id ? match.player_a_name : match.player_b_name

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{match.game && match.game.icon} {match.game && match.game.name}</h1>
        <p className="page-subtitle">{match.player_a_name} vs {match.player_b_name}</p>
      </div>

      <div className="card arena-card">
        <span className={`arena-badge arena-status-badge--${match.status}`}>{STATUS_LABEL[match.status] || match.status}</span>

        {error && <p className="arena-msg arena-msg--err">{error}</p>}

        {match.status === 'drafting' && (
          <p className="arena-match-hint">
            <Link to={`/arena/draft/${match.public_id}`} className="btn btn-primary arena-inline-btn">ドラフトを続ける</Link>
          </p>
        )}

        {match.status === 'finished' && (
          <div className="arena-result-summary">
            <p>
              勝者: <strong>{match.winner_side === 'A' ? match.player_a_name : match.player_b_name}</strong>
              {' '}（{match.score_a} - {match.score_b}）
            </p>
            {myDelta && (
              <p className="arena-rating-delta">
                あなたのレート: {Math.round(myDelta.rating_before)} → {Math.round(myDelta.rating_after)}
                {' '}（{myDelta.result === 'win' ? '勝利' : '敗北'}、
                {myDelta.rating_after - myDelta.rating_before >= 0 ? '+' : ''}
                {Math.round(myDelta.rating_after - myDelta.rating_before)}）
              </p>
            )}
          </div>
        )}

        {match.series && (
          <div className="arena-series-box">
            <p className="arena-panel-subtitle">
              🔥 シリーズ戦績（BO{match.series.best_of}・{match.series.wins_needed}本先取）
            </p>
            <p className="arena-series-score">
              {match.series.player_a_name} <strong>{match.series.wins_a}</strong>
              {' - '}
              <strong>{match.series.wins_b}</strong> {match.series.player_b_name}
            </p>
            {match.series.is_over ? (
              <p className="arena-msg">
                このシリーズは決着しました（{match.series.wins_a > match.series.wins_b ? match.series.player_a_name : match.series.player_b_name} の勝利）。
              </p>
            ) : (
              match.status === 'finished' && (
                <div className="arena-form-actions">
                  <button className="btn btn-primary arena-inline-btn" disabled={busy} onClick={handleStartNextGame}>
                    次のゲームを開始する（{match.series.games_finished + 1}試合目）
                  </button>
                </div>
              )
            )}
            {nextGameError && <p className="arena-msg arena-msg--err">{nextGameError}</p>}
          </div>
        )}

        {match.status === 'cancelled' && <p className="arena-empty">この試合は中止されました</p>}

        {canReport && (
          <form className="arena-inline-form" onSubmit={handleReport}>
            <p className="arena-panel-subtitle">結果を申告する</p>
            <div className="arena-form-grid">
              <div className="form-group">
                <label className="form-label">勝者</label>
                <select className="form-input" value={winner} onChange={e => setWinner(e.target.value)}>
                  <option value="A">{match.player_a_name}</option>
                  <option value="B">{match.player_b_name}</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">スコア（{match.player_a_name}）</label>
                <input className="form-input" type="number" min="0" value={scoreA} onChange={e => setScoreA(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">スコア（{match.player_b_name}）</label>
                <input className="form-input" type="number" min="0" value={scoreB} onChange={e => setScoreB(e.target.value)} />
              </div>
            </div>
            <button type="submit" className="btn btn-primary arena-inline-btn" disabled={busy}>申告する</button>
          </form>
        )}

        {match.status === 'reported' && isReporter && (
          <p className="arena-msg">{reporterName} が申告済みです。相手の承認を待っています。</p>
        )}

        {canConfirm && (
          <div className="arena-form-actions">
            <p className="arena-panel-subtitle">{reporterName} が結果を申告しました</p>
            <button className="btn btn-primary arena-inline-btn" disabled={busy} onClick={handleConfirm}>この結果を承認する</button>
          </div>
        )}

        {canCancel && (
          <div className="arena-form-actions arena-match-cancel">
            <button className="btn btn-danger arena-inline-btn" disabled={busy} onClick={handleCancel}>試合を中止する</button>
          </div>
        )}
      </div>

      <p className="arena-back-link"><Link to="/arena">← バンピックトップに戻る</Link></p>
    </>
  )
}
