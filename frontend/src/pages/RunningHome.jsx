import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import runningApi, { RunningApiError } from '../lib/runningApi.js'
import RecordForm from '../components/running/RecordForm.jsx'

function errMsg(e) {
  return e instanceof RunningApiError ? e.message : '通信エラーが発生しました'
}

function formatDuration(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}

function formatPace(paceSPerKm) {
  if (!paceSPerKm) return '—'
  return `${Math.floor(paceSPerKm / 60)}'${String(paceSPerKm % 60).padStart(2, '0')}"`
}

export default function RunningHome() {
  const [summary, setSummary] = useState(null)
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Discord 未連携（403）は専用の案内を出すため、通常のエラーとは分けて持つ
  const [discordRequired, setDiscordRequired] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setDiscordRequired(false)
    try {
      const [s, r] = await Promise.all([
        runningApi.get('/v1/me/summary'),
        runningApi.get('/v1/records?limit=5'),
      ])
      setSummary(s)
      setRecords(r.records || [])
    } catch (e) {
      if (e instanceof RunningApiError && e.status === 403) {
        setDiscordRequired(true)
      } else {
        setError(errMsg(e))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🏃 ランニング</h1>
        <p className="page-subtitle">走った記録をつけて、月間・週間の累計を確認できます</p>
      </div>

      {loading && <p className="running-loading">読み込み中…</p>}

      {!loading && discordRequired && (
        <div className="card running-card">
          <div className="alert alert-error">
            ランニング機能を使うには Discord でログインしてください。
          </div>
          <Link to="/login" className="btn btn-secondary">ログインページへ</Link>
        </div>
      )}

      {!loading && !discordRequired && error && <p className="running-error">{error}</p>}

      {!loading && !discordRequired && !error && (
        <>
          {summary && (
            <div className="card running-card">
              <h2 className="running-section-title">今月の累計</h2>
              <div className="running-summary-main">
                <span className="running-summary-value">{summary.month.distanceKm}km</span>
                <span className="running-summary-detail">
                  {formatDuration(summary.month.durationS)} ・ {summary.month.runs}回
                </span>
              </div>
              {summary.nextThreshold && (
                <p className="running-threshold">
                  {summary.nextThreshold.km}km まであと {summary.nextThreshold.remainingKm}km
                </p>
              )}
              <p className="running-summary-sub">
                今週 {summary.week.distanceKm}km / {summary.week.runs}回
                ・　通算 {summary.total.distanceKm}km / {summary.total.runs}回
              </p>
            </div>
          )}

          <div className="card running-card">
            <h2 className="running-section-title">記録する</h2>
            <RecordForm onSubmitted={load} />
          </div>

          <div className="card running-card">
            <h2 className="running-section-title">直近の記録</h2>
            {records.length === 0 ? (
              <p className="running-empty">まだ記録がありません</p>
            ) : (
              <ul className="running-record-list">
                {records.map(r => (
                  <li key={r.id} className="running-record-item">
                    <span className="running-record-date">{r.runDate}</span>
                    <span className="running-record-distance">{r.distanceKm}km</span>
                    <span className="running-record-duration">{formatDuration(r.durationS)}</span>
                    <span className="running-record-pace">{formatPace(r.paceSPerKm)}/km</span>
                    <span className="running-record-course">{r.course || ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </>
  )
}
