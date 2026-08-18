import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'
import { useAuth } from '../App.jsx'
import useDraftSync from '../hooks/useDraftSync.js'
import EntryGrid from '../components/arena/EntryGrid.jsx'
import DraftTimeline from '../components/arena/DraftTimeline.jsx'
import TurnTimer from '../components/arena/TurnTimer.jsx'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

// BAN/PICKドラフト画面。ローカル（1画面交互操作）とオンライン（ポーリング同期）の両方に対応する。
export default function ArenaDraft() {
  const { publicId } = useParams()
  const navigate = useNavigate()
  const { auth } = useAuth()

  // useDraftSync のポーリング可否は mode に依存するため、match が届いて実際の
  // mode（local/online）がわかってから渡す。届くまでは null（ポーリングしない）。
  const [syncMode, setSyncMode] = useState(null)
  const { match, draft, loading, error, acting, act } = useDraftSync(publicId, syncMode)

  const [entries, setEntries] = useState([])
  const [entriesError, setEntriesError] = useState(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (match && match.mode && match.mode !== syncMode) {
      setSyncMode(match.mode)
    }
  }, [match && match.mode, syncMode])

  useEffect(() => {
    if (!match || !match.game) return
    arenaApi.get(`/v1/games/${match.game.slug}/entries`)
      .then(data => setEntries(data.entries))
      .catch(e => setEntriesError(errMsg(e)))
  }, [match && match.game && match.game.slug])

  // waiting / drafting 以外に進んだら試合詳細画面へ遷移する
  useEffect(() => {
    if (match && match.status !== 'drafting' && match.status !== 'waiting') {
      navigate(`/arena/${publicId}`, { replace: true })
    }
  }, [match && match.status, publicId, navigate])

  const isOnline = match && match.mode === 'online'

  const isMyTurn = useMemo(() => {
    if (!match || !draft) return false
    if (match.mode === 'local') return true // ローカルは作成者が両側を操作する
    const side = draft.current_side
    if (side === 'A') return match.player_a_id === auth.userId
    if (side === 'B') return match.player_b_id != null && match.player_b_id === auth.userId
    return false
  }, [match, draft, auth.userId])

  const unavailableIds = useMemo(() => {
    const ids = new Set()
    if (!draft || !match || !match.ruleset) return ids
    draft.banned_entry_ids.forEach(id => ids.add(id))
    draft.fearless_excluded_ids.forEach(id => ids.add(id))
    const side = draft.current_side
    if (side === 'A') {
      draft.picked_entry_ids_a.forEach(id => ids.add(id))
      if (!match.ruleset.mirror_allowed) draft.picked_entry_ids_b.forEach(id => ids.add(id))
    } else if (side === 'B') {
      draft.picked_entry_ids_b.forEach(id => ids.add(id))
      if (!match.ruleset.mirror_allowed) draft.picked_entry_ids_a.forEach(id => ids.add(id))
    }
    return ids
  }, [draft, match])

  async function handleSelect(entryId) {
    if (!draft || !isMyTurn) return
    await act(draft.turn_index, draft.current_type, entryId)
  }

  async function handleCopyCode() {
    if (!match) return
    try {
      await navigator.clipboard.writeText(match.public_id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      // クリップボードAPIが使えない環境もあるため失敗しても無視する
    }
  }

  async function handleCancel() {
    if (!confirm('この試合を中止しますか？')) return
    setCancelling(true)
    setCancelError(null)
    try {
      await arenaApi.post(`/v1/matches/${publicId}/cancel`, {})
      navigate(`/arena/${publicId}`, { replace: true })
    } catch (e) {
      setCancelError(errMsg(e))
    } finally {
      setCancelling(false)
    }
  }

  if (loading) {
    return <p className="arena-loading">読み込み中…</p>
  }
  if (error && !match) {
    return <p className="arena-msg arena-msg--err">{error}</p>
  }
  if (!match) {
    return null
  }

  // オンラインで相手の参加待ち
  if (match.status === 'waiting') {
    const isCreator = match.player_a_id === auth.userId
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">{match.game && match.game.icon} {match.game && match.game.name} — 対戦相手を待っています</h1>
          <p className="page-subtitle">オンライン対戦</p>
        </div>

        <div className="card arena-card">
          <div className="arena-room-code-box">
            <p className="arena-panel-subtitle">このコードを相手に共有してください</p>
            <p className="arena-room-code">{match.public_id}</p>
            <div className="arena-form-actions">
              <button type="button" className="btn btn-secondary arena-inline-btn" onClick={handleCopyCode}>
                {copied ? 'コピーしました' : 'コードをコピー'}
              </button>
            </div>
          </div>

          {match.player_b_name && (
            <p className="arena-msg">招待した相手: {match.player_b_name} さんの参加を待っています</p>
          )}

          {error && <p className="arena-msg arena-msg--err">{error}</p>}
          {cancelError && <p className="arena-msg arena-msg--err">{cancelError}</p>}

          {isCreator && (
            <div className="arena-form-actions arena-match-cancel">
              <button className="btn btn-danger arena-inline-btn" disabled={cancelling} onClick={handleCancel}>
                この対戦を中止する
              </button>
            </div>
          )}
        </div>

        <p className="arena-back-link"><Link to="/arena">← バンピックトップに戻る</Link></p>
      </>
    )
  }

  if (!draft || match.status !== 'drafting') {
    return null
  }

  const sideLabel = draft.current_side === 'A' ? match.player_a_name : match.player_b_name
  const actionLabel = draft.current_type === 'ban' ? 'BAN' : 'PICK'
  const actionCls = draft.current_type === 'ban' ? 'arena-step-ban' : 'arena-step-pick'

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{match.game && match.game.icon} {match.game && match.game.name} — ドラフト</h1>
        <p className="page-subtitle">{match.player_a_name} vs {match.player_b_name}（{isOnline ? 'オンライン対戦' : 'ローカル対戦'}）</p>
      </div>

      <div className="card arena-card">
        <DraftTimeline sequence={draft.sequence} actions={draft.actions} currentIndex={draft.turn_index} />
      </div>

      <div className="card arena-card">
        <div className="arena-turn-banner">
          <strong>{sideLabel}</strong> の手番です — <span className={`arena-seq-chip ${actionCls}`}>{actionLabel}</span>
          {draft.turn_deadline && <TurnTimer deadline={draft.turn_deadline} />}
          {isOnline ? (
            <p className="arena-turn-hint">{isMyTurn ? 'あなたの手番です。選択してください。' : '相手の手番です。しばらくお待ちください。'}</p>
          ) : (
            <p className="arena-turn-hint">ローカル対戦です。この操作は同じ画面上で行ってください。</p>
          )}
        </div>

        {error && <p className="arena-msg arena-msg--err">{error}</p>}
        {entriesError && <p className="arena-msg arena-msg--err">{entriesError}</p>}

        <EntryGrid
          entries={entries}
          unavailableIds={unavailableIds}
          onSelect={handleSelect}
          disabled={acting || (isOnline && !isMyTurn)}
          entryLabel={match.game && match.game.entry_label}
        />
      </div>

      <p className="arena-back-link"><Link to="/arena">← バンピックトップに戻る</Link></p>
    </>
  )
}
