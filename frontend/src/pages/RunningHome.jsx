import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import runningApi, { RunningApiError } from '../lib/runningApi.js'
import RecordForm from '../components/running/RecordForm.jsx'
import PhotoUploader from '../components/running/PhotoUploader.jsx'
import { formatDuration, formatPace } from '../lib/runningFormat.js'

function errMsg(e) {
  return e instanceof RunningApiError ? e.message : '通信エラーが発生しました'
}

export default function RunningHome() {
  const [summary, setSummary] = useState(null)
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Discord 未連携（403）は専用の案内を出すため、通常のエラーとは分けて持つ
  const [discordRequired, setDiscordRequired] = useState(false)
  // 記録直後にその記録へ写真を添付できるようにするための導線。null なら非表示
  const [justCreated, setJustCreated] = useState(null)

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

  // 記録作成直後は写真添付の導線を出しつつ、一覧・累計を最新化する
  function handleRecordSubmitted(record) {
    setJustCreated(record)
    load()
  }

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
            <RecordForm onSubmitted={handleRecordSubmitted} />
          </div>

          {justCreated && (
            <div className="card running-card running-photo-prompt">
              <div className="running-section-header">
                <h2 className="running-section-title">写真を追加</h2>
                <button
                  type="button"
                  className="running-see-all running-photo-prompt-close"
                  onClick={() => setJustCreated(null)}
                >
                  閉じる
                </button>
              </div>
              <PhotoUploader
                recordId={justCreated.id}
                photoUrl={justCreated.photoUrl}
                onUploaded={(updated) => { setJustCreated(updated); load() }}
              />
            </div>
          )}

          <div className="running-nav-links">
            <Link to="/running/ranking" className="btn btn-secondary">🏆 ランキングを見る</Link>
            <Link to="/running/records" className="btn btn-secondary">📋 記録一覧を見る</Link>
          </div>

          <div className="card running-card">
            <div className="running-section-header">
              <h2 className="running-section-title">直近の記録</h2>
              <Link to="/running/records" className="running-see-all">すべて見る →</Link>
            </div>
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
