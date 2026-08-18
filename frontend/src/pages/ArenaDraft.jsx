import { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'
import useDraftSync from '../hooks/useDraftSync.js'
import EntryGrid from '../components/arena/EntryGrid.jsx'
import DraftTimeline from '../components/arena/DraftTimeline.jsx'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

// ローカル（1画面）でのBAN/PICKドラフト画面。
export default function ArenaDraft() {
  const { publicId } = useParams()
  const navigate = useNavigate()
  const { match, draft, loading, error, acting, act } = useDraftSync(publicId, 'local')

  const [entries, setEntries] = useState([])
  const [entriesError, setEntriesError] = useState(null)

  useEffect(() => {
    if (!match || !match.game) return
    arenaApi.get(`/v1/games/${match.game.slug}/entries`)
      .then(data => setEntries(data.entries))
      .catch(e => setEntriesError(errMsg(e)))
  }, [match && match.game && match.game.slug])

  useEffect(() => {
    if (match && match.status !== 'drafting') {
      navigate(`/arena/${publicId}`, { replace: true })
    }
  }, [match && match.status, publicId, navigate])

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
    if (!draft) return
    await act(draft.turn_index, draft.current_type, entryId)
  }

  if (loading) {
    return <p className="arena-loading">読み込み中…</p>
  }
  if (error && !match) {
    return <p className="arena-msg arena-msg--err">{error}</p>
  }
  if (!match || !draft || match.status !== 'drafting') {
    return null
  }

  const sideLabel = draft.current_side === 'A' ? match.player_a_name : match.player_b_name
  const actionLabel = draft.current_type === 'ban' ? 'BAN' : 'PICK'
  const actionCls = draft.current_type === 'ban' ? 'arena-step-ban' : 'arena-step-pick'

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">{match.game && match.game.icon} {match.game && match.game.name} — ドラフト</h1>
        <p className="page-subtitle">{match.player_a_name} vs {match.player_b_name}（ローカル対戦）</p>
      </div>

      <div className="card arena-card">
        <DraftTimeline sequence={draft.sequence} actions={draft.actions} currentIndex={draft.turn_index} />
      </div>

      <div className="card arena-card">
        <div className="arena-turn-banner">
          <strong>{sideLabel}</strong> の手番です — <span className={`arena-seq-chip ${actionCls}`}>{actionLabel}</span>
          <p className="arena-turn-hint">ローカル対戦です。この操作は同じ画面上で行ってください。</p>
        </div>

        {error && <p className="arena-msg arena-msg--err">{error}</p>}
        {entriesError && <p className="arena-msg arena-msg--err">{entriesError}</p>}

        <EntryGrid
          entries={entries}
          unavailableIds={unavailableIds}
          onSelect={handleSelect}
          disabled={acting}
          entryLabel={match.game && match.game.entry_label}
        />
      </div>

      <p className="arena-back-link"><Link to="/arena">← バンピックトップに戻る</Link></p>
    </>
  )
}
