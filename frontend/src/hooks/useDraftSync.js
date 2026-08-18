import { useState, useEffect, useCallback, useRef } from 'react'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

// online モードのポーリング間隔（ミリ秒）
const ARENA_POLL_INTERVAL_MS = 1000

// ドラフトの同期を担うフック。呼び出し側から見た形は local/online で同一。
//
// local: POST /draft の戻り値をそのまま state に入れる（ポーリング不要）。
// online: since=version で1秒間隔ポーリングする。304（変化なし）は無視し、
//   match が waiting/drafting を離れたら止める。呼び出し側（ArenaDraft.jsx）の
//   使い方は local と変えない。
export default function useDraftSync(publicId, mode) {
  const [match, setMatch] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [acting, setActing] = useState(false)

  // ポーリングのタイマークロージャから常に最新の match を読めるようにする ref
  const matchRef = useRef(null)

  // data が null になるのは 304（変化なし）のとき。ポーリングで無視するために
  // ここで早期returnしておく。
  const applyResponse = useCallback((data) => {
    if (!data) return
    setMatch(data.match)
    matchRef.current = data.match
    if (data.draft) setDraft(data.draft)
  }, [])

  const refresh = useCallback(async (since) => {
    try {
      const path = since === undefined || since === null
        ? `/v1/matches/${publicId}/draft`
        : `/v1/matches/${publicId}/draft?since=${since}`
      const data = await arenaApi.get(path)
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
  }, [refresh])

  // online: waiting/drafting の間だけ1秒間隔でポーリングする。
  // アンマウント時・publicId変更時・drafting を離れた時に確実に止める。
  useEffect(() => {
    if (mode !== 'online') return undefined

    let cancelled = false
    let timer = null

    function isPollable(m) {
      return !m || m.status === 'waiting' || m.status === 'drafting'
    }

    async function tick() {
      if (cancelled) return
      await refresh(matchRef.current ? matchRef.current.version : undefined)
      if (!cancelled && isPollable(matchRef.current)) {
        timer = setTimeout(tick, ARENA_POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(tick, ARENA_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [mode, publicId, refresh])

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
