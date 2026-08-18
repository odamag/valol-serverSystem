import { useState, useEffect, useCallback } from 'react'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

// ドラフトの同期を担うフック。呼び出し側から見た形は local/online で同一にする
// （Phase 4 でオンラインモードのポーリングを足すだけで済むように、ここで形を決めておく）。
//
// local: POST /draft の戻り値をそのまま state に入れる（ポーリング不要）。
// online（Phase 4予定）: ここに setInterval で `since=version` ポーリングを追加し、
//   304（変化なし）は無視する。呼び出し側（ArenaDraft.jsx）の使い方は変えない想定。
export default function useDraftSync(publicId, mode) {
  const [match, setMatch] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [acting, setActing] = useState(false)

  // data が null になるのは 304（変化なし）のとき。Phase 4のポーリングで無視するために
  // ここで早期returnしておく。
  const applyResponse = useCallback((data) => {
    if (!data) return
    setMatch(data.match)
    if (data.draft) setDraft(data.draft)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await arenaApi.get(`/v1/matches/${publicId}/draft`)
      applyResponse(data)
      setError(null)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
    } finally {
      setLoading(false)
    }
  }, [publicId, applyResponse])

  useEffect(() => {
    setLoading(true)
    refresh()
    // mode: 現状は 'local' のみ使う（ポーリング無し）。'online' は Phase 4 で
    // ここに setInterval(() => refresh with since=), clearInterval を追加する。
  }, [refresh, mode])

  const act = useCallback(async (seq, action, entryId) => {
    setActing(true)
    setError(null)
    try {
      const data = await arenaApi.post(`/v1/matches/${publicId}/draft`, { seq, action, entry_id: entryId })
      applyResponse(data)
      return true
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
      return false
    } finally {
      setActing(false)
    }
  }, [publicId, applyResponse])

  return { match, draft, loading, error, acting, act, refresh }
}
