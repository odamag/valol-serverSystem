import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../App.jsx'
import useSeriesSync from '../hooks/useSeriesSync.js'
import TurnTimer from '../components/arena/TurnTimer.jsx'
import DraftTimeline from '../components/arena/DraftTimeline.jsx'

// ルーレット演出の回転時間（ミリ秒）。結果はサーバーが先に確定しているので、
// ここは見た目だけの遅延。
const SPIN_MS = 1600

function sideLabel(side) {
  return side === 'A' ? 'A側（先手）' : side === 'B' ? 'B側（後手）' : '—'
}

// ── ルーレット ────────────────────────────────────────────────
function RoulettePanel({ series, onSpin, acting, myId }) {
  const [spinning, setSpinning] = useState(false)

  const p1 = series.player1_name
  const p2 = series.player2_name || '（相手待ち）'

  async function handleSpin() {
    setSpinning(true)
    const ok = await onSpin()
    // 結果はサーバー確定済み。演出のぶんだけ待ってから開示する
    setTimeout(() => setSpinning(false), ok ? SPIN_MS : 0)
  }

  return (
    <div className="card arena-card arena-roulette">
      <h2 className="arena-section-title">🎰 先手・後手を決める</h2>
      <p className="arena-muted">
        どちらが A側（先手）になるかをルーレットで決めます。結果はサーバー側で確定し、引き直しはできません。
      </p>

      <div className={`arena-roulette-wheel${spinning ? ' arena-roulette-wheel--spinning' : ''}`}>
        <div className="arena-roulette-name">{p1}</div>
        <div className="arena-roulette-vs">VS</div>
        <div className="arena-roulette-name">{p2}</div>
      </div>

      {series.player2_id === null ? (
        <p className="arena-muted">相手の参加を待っています。</p>
      ) : (
        <button className="btn btn-primary" onClick={handleSpin} disabled={acting || spinning}>
          {spinning ? '抽選中…' : 'ルーレットを回す'}
        </button>
      )}
    </div>
  )
}

// ── タイトルドラフト ──────────────────────────────────────────
function DraftPanel({ series, draft, onAct, acting, myId }) {
  const [pending, setPending] = useState(null)

  const seq = draft.turn_index
  const step = draft.sequence[seq]
  const isLocal = series.mode === 'local'

  // 自分がどちら側か。ローカルは作成者が両側を操作できる。
  const mySide = series.side_a_user_id === myId ? 'A'
    : series.side_b_user_id === myId ? 'B' : null
  const myTurn = isLocal ? series.created_by === myId : step && step.s === mySide

  const remaining = useMemo(
    () => draft.pool.filter(g => g.status === 'available'),
    [draft.pool]
  )

  async function choose(gameId) {
    if (!step || !myTurn || acting) return
    setPending(gameId)
    await onAct(seq, step.t, gameId)
    setPending(null)
  }

  return (
    <>
      <div className="card arena-card">
        <div className="arena-turn-head">
          <div>
            <span className={`arena-step-badge arena-step-${step ? step.t : 'done'}`}>
              {step ? (step.t === 'ban' ? 'BAN' : 'PICK') : '完了'}
            </span>
            <strong className="arena-turn-side">{step ? sideLabel(step.s) : ''}</strong>
            {isLocal && <span className="arena-muted">（1画面モード：交互に操作してください）</span>}
          </div>
          {draft.turn_deadline && <TurnTimer deadline={draft.turn_deadline} />}
        </div>

        <DraftTimeline sequence={draft.sequence} actions={draft.actions} turnIndex={seq} />

        {!myTurn && <p className="arena-muted">相手の手番です。しばらくお待ちください。</p>}
      </div>

      <div className="card arena-card">
        <h2 className="arena-section-title">
          タイトルプール（残り {remaining.length} / {draft.pool.length}）
        </h2>
        <div className="arena-title-grid">
          {draft.pool.map(g => {
            const taken = g.status !== 'available'
            return (
              <button
                key={g.id}
                className={`arena-title-card arena-title-card--${g.status}`}
                disabled={taken || !myTurn || acting}
                onClick={() => choose(g.id)}
              >
                <span className="arena-title-icon">{g.icon || '🎮'}</span>
                <span className="arena-title-name">{g.name}</span>
                {taken && (
                  <span className="arena-title-mark">
                    {g.status === 'banned' ? `BAN${g.side ? ` (${g.side})` : ''}`
                      : g.status === 'picked' ? `PICK${g.side ? ` (${g.side})` : ''}`
                      : 'Decider'}
                  </span>
                )}
                {pending === g.id && <span className="arena-title-mark">送信中…</span>}
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}

// ── 5番勝負ボード ─────────────────────────────────────────────
function SeriesBoard({ series, draft, onReport, onConfirm, acting, myId }) {
  const winsNeeded = series.format ? series.format.wins_needed : 3
  const lineup = draft.lineup || []
  const nextNo = lineup.find(g => !g.winner_side)?.game_no ?? null

  function nameForSide(side) {
    const uid = side === 'A' ? series.side_a_user_id : series.side_b_user_id
    if (uid === series.player1_id) return series.player1_name
    if (uid === series.player2_id) return series.player2_name
    return sideLabel(side)
  }

  return (
    <div className="card arena-card">
      <div className="arena-score-head">
        <div className="arena-score-side">
          <span className="arena-muted">A側</span>
          <strong>{nameForSide('A')}</strong>
          <span className="arena-score-num">{series.wins_a}</span>
        </div>
        <span className="arena-score-sep">－</span>
        <div className="arena-score-side">
          <span className="arena-score-num">{series.wins_b}</span>
          <strong>{nameForSide('B')}</strong>
          <span className="arena-muted">B側</span>
        </div>
      </div>
      <p className="arena-muted arena-center">先に {winsNeeded} 勝したほうがシリーズ勝者</p>

      {series.status === 'finished' && (
        <p className="arena-winner-banner">
          🏆 {nameForSide(series.winner_side)} のシリーズ勝利
        </p>
      )}

      <ol className="arena-lineup">
        {lineup.map(g => {
          const isNext = g.game_no === nextNo && series.status === 'playing'
          const awaiting = !g.winner_side && g.reported_by !== null
          const iReported = g.reported_by === myId
          return (
            <li
              key={g.game_no}
              className={`arena-lineup-row${g.winner_side ? ' arena-lineup-row--done' : ''}${isNext ? ' arena-lineup-row--next' : ''}`}
            >
              <span className="arena-lineup-no">第{g.game_no}試合</span>
              <span className="arena-lineup-icon">{g.game_icon || '🎮'}</span>
              <span className="arena-lineup-name">
                {g.game_name}
                {g.is_decider
                  ? <span className="arena-lineup-tag arena-lineup-tag--decider">Decider</span>
                  : <span className="arena-lineup-tag">PICK {g.picked_by}</span>}
              </span>

              {g.winner_side ? (
                <span className="arena-lineup-result">{nameForSide(g.winner_side)} の勝ち</span>
              ) : awaiting ? (
                iReported ? (
                  <span className="arena-muted">相手の承認待ち</span>
                ) : (
                  <button className="btn btn-primary" disabled={acting} onClick={() => onConfirm(g.game_no)}>
                    承認する
                  </button>
                )
              ) : isNext ? (
                <span className="arena-lineup-report">
                  <button className="btn btn-secondary" disabled={acting} onClick={() => onReport(g.game_no, 'A')}>
                    {nameForSide('A')} の勝ち
                  </button>
                  <button className="btn btn-secondary" disabled={acting} onClick={() => onReport(g.game_no, 'B')}>
                    {nameForSide('B')} の勝ち
                  </button>
                </span>
              ) : (
                <span className="arena-muted">—</span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ── ページ本体 ────────────────────────────────────────────────
export default function ArenaSeries() {
  const { publicId } = useParams()
  const { auth } = useAuth()
  const myId = auth.userId

  const [copied, setCopied] = useState(false)
  const sync = useSeriesSync(publicId)

  if (sync.loading && !sync.series) return <p className="arena-loading">読み込み中…</p>

  const s = sync.series
  const d = sync.draft
  if (!s) {
    return (
      <div className="card arena-card">
        <p className="arena-error">{sync.error || 'シリーズを読み込めませんでした'}</p>
        <Link to="/arena" className="btn btn-secondary">戻る</Link>
      </div>
    )
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎴 5番勝負</h1>
        <p className="page-subtitle">
          {s.format ? s.format.name : ''} ・ {s.mode === 'local' ? '1画面モード' : 'オンライン'}
        </p>
      </div>

      {sync.error && <p className="arena-error">{sync.error}</p>}

      {s.status === 'waiting' && (
        <div className="card arena-card">
          <h2 className="arena-section-title">相手の参加を待っています</h2>
          <p className="arena-muted">このコードを相手に伝えてください。</p>
          <div className="arena-room-code">{s.public_id}</div>
          <button
            className="btn btn-secondary"
            onClick={() => { navigator.clipboard?.writeText(s.public_id); setCopied(true) }}
          >
            {copied ? 'コピーしました' : 'コードをコピー'}
          </button>
        </div>
      )}

      {s.status === 'roulette' && (
        <RoulettePanel series={s} onSpin={sync.spinRoulette} acting={sync.acting} myId={myId} />
      )}

      {s.status === 'drafting' && d && (
        <DraftPanel series={s} draft={d} onAct={sync.act} acting={sync.acting} myId={myId} />
      )}

      {(s.status === 'playing' || s.status === 'finished') && d && (
        <>
          <SeriesBoard
            series={s}
            draft={d}
            onReport={sync.reportGame}
            onConfirm={sync.confirmGame}
            acting={sync.acting}
            myId={myId}
          />
          <div className="card arena-card">
            <h2 className="arena-section-title">ドラフト経過</h2>
            <DraftTimeline sequence={d.sequence} actions={d.actions} turnIndex={d.turn_index} />
          </div>
        </>
      )}

      <Link to="/arena" className="btn btn-secondary arena-back">← バンピックトップへ</Link>
    </>
  )
}
