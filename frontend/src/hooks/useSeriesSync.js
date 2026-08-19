import { useState, useEffect, useCallback, useRef } from 'react'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

// online モードのポーリング間隔（ミリ秒）
const ARENA_POLL_INTERVAL_MS = 1000

// シリーズ（タイトルドラフト → 5番勝負）の同期を担うフック。
// 呼び出し側から見た形は local/online で同一。
//
// local: POST の戻り値をそのまま state に入れる（ポーリング不要）。
// online: since=version で1秒間隔ポーリングする。304（変化なし）は無視し、
//   waiting/roulette/drafting を離れたら止める。
export default function useSeriesSync(publicId) {
  const [series, setSeries] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [acting, setActing] = useState(false)

  // ポーリングのタイマークロージャから常に最新の series を読めるようにする ref
  const seriesRef = useRef(null)

  // data が null になるのは 304（変化なし）のとき。ポーリングで無視するために早期return。
  const applyResponse = useCallback((data) => {
    if (!data) return
    if (data.series) {
      setSeries(data.series)
      seriesRef.current = data.series
    }
    if (data.draft) setDraft(data.draft)
    if (data.state) setDraft(data.state)
  }, [])

  const refresh = useCallback(async (since) => {
    try {
      const path = since === undefined || since === null
        ? `/v1/series/${publicId}`
        : `/v1/series/${publicId}/draft?since=${since}`
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

  // online: 決着前だけ1秒間隔でポーリングする。
  // アンマウント時・publicId変更時・終了時に確実に止める。
  // mode は series 自身から読む（読み込み前は不明なので、判明してから開始する）
  const mode = series ? series.mode : null

  useEffect(() => {
    if (mode !== 'online') return undefined

    let cancelled = false
    let timer = null

    function isPollable(s) {
      return !s || s.status === 'waiting' || s.status === 'roulette' ||
             s.status === 'drafting' || s.status === 'playing'
    }

    async function tick() {
      if (cancelled) return
      await refresh(seriesRef.current ? seriesRef.current.version : undefined)
      if (!cancelled && isPollable(seriesRef.current)) {
        timer = setTimeout(tick, ARENA_POLL_INTERVAL_MS)
      }
    }

    timer = setTimeout(tick, ARENA_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [mode, publicId, refresh])

  // 汎用のPOSTラッパ。成功したら state を更新して true を返す。
  const post = useCallback(async (path, body) => {
    setActing(true)
    setError(null)
    try {
      const data = await arenaApi.post(path, body)
      applyResponse(data)
      return true
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
      return false
    } finally {
      setActing(false)
    }
  }, [applyResponse])

  // ルーレット（A/B決定）。サーバー側で確定し、引き直しは不可。
  const spinRoulette = useCallback(
    () => post(`/v1/series/${publicId}/roulette`, {}),
    [post, publicId]
  )

  // タイトルのBAN/PICK
  const act = useCallback(
    (seq, action, gameId) => post(`/v1/series/${publicId}/draft`, { seq, action, game_id: gameId }),
    [post, publicId]
  )

  // 試合の勝敗申告 / 相手による承認
  const reportGame = useCallback(
    (gameNo, winner) => post(`/v1/series/${publicId}/games/${gameNo}/result`, { winner }),
    [post, publicId]
  )
  const confirmGame = useCallback(
    (gameNo) => post(`/v1/series/${publicId}/games/${gameNo}/confirm`, {}),
    [post, publicId]
  )

  return { series, draft, loading, error, acting, spinRoulette, act, reportGame, confirmGame, refresh }
}
