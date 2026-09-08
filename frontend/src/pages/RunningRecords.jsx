import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import runningApi, { RunningApiError } from '../lib/runningApi.js'
import { WEATHER_OPTIONS, WEATHER_LABELS, parseDurationToSeconds, formatDuration, formatPace } from '../lib/runningFormat.js'

function errMsg(e) {
  return e instanceof RunningApiError ? e.message : '通信エラーが発生しました'
}

// 時間のパース・整形・天候の選択肢は新規作成フォームと共有する（lib/runningFormat.js）

// 記録の編集用インラインフォーム。
// 入力項目・バリデーションは components/running/RecordForm.jsx（新規作成用）と揃えているが、
// 本タスクでは RecordForm.jsx が編集対象ファイルに含まれていない（Phase1の新規作成の挙動を
// 壊さないための境界）ため、あえて共通化はせずこのファイル内に編集専用の小さなフォームとして
// 別実装している。
function EditRow({ record, onSaved, onConflict, onCancel }) {
  const [distanceKm, setDistanceKm] = useState(String(record.distanceKm))
  const [durationText, setDurationText] = useState(formatDuration(record.durationS))
  const [runDate, setRunDate] = useState(record.runDate)
  const [course, setCourse] = useState(record.course || '')
  const [memo, setMemo] = useState(record.memo || '')
  const [weather, setWeather] = useState(record.weather || '')
  const [heartRate, setHeartRate] = useState(record.heartRate != null ? String(record.heartRate) : '')
  const [calories, setCalories] = useState(record.calories != null ? String(record.calories) : '')
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')

    const distance = Number(distanceKm)
    if (!distanceKm || Number.isNaN(distance) || distance < 0.1 || distance > 300) {
      setFormError('距離は 0.1〜300km の範囲で入力してください')
      return
    }
    const durationS = parseDurationToSeconds(durationText)
    if (durationS === null) {
      setFormError('時間は 26:30 または 1:05:12 の形式で入力してください')
      return
    }

    // 楽観ロック: 取得時点の updatedAt を必ず一緒に送る（契約書 §4）
    const body = {
      distanceKm: distance,
      durationS,
      runDate,
      course: course.trim() || null,
      memo: memo.trim() || null,
      weather: weather || null,
      heartRate: heartRate !== '' ? Number(heartRate) : null,
      calories: calories !== '' ? Number(calories) : null,
      updatedAt: record.updatedAt,
    }

    setSubmitting(true)
    try {
      const data = await runningApi.patch(`/v1/records/${record.id}`, body)
      onSaved(data.record)
    } catch (err) {
      if (err instanceof RunningApiError && err.status === 409) {
        onConflict()
        return
      }
      setFormError(err instanceof RunningApiError ? err.message : '通信エラーが発生しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="running-inline-form" onSubmit={handleSubmit}>
      {formError && <div className="alert alert-error">{formError}</div>}

      <div className="running-form-grid">
        <div className="form-group">
          <label className="form-label">距離 (km)</label>
          <input
            className="form-input"
            type="number"
            step="0.01"
            min="0.1"
            max="300"
            value={distanceKm}
            onChange={e => setDistanceKm(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">時間（mm:ss または hh:mm:ss）</label>
          <input
            className="form-input"
            type="text"
            value={durationText}
            onChange={e => setDurationText(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">日付</label>
          <input className="form-input" type="date" value={runDate} onChange={e => setRunDate(e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-label">コース名</label>
          <input
            className="form-input"
            type="text"
            maxLength={100}
            value={course}
            onChange={e => setCourse(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">天候</label>
          <select className="form-input" value={weather} onChange={e => setWeather(e.target.value)}>
            {WEATHER_OPTIONS.map(w => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">平均心拍数 (bpm)</label>
          <input
            className="form-input"
            type="number"
            min="30"
            max="250"
            value={heartRate}
            onChange={e => setHeartRate(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">消費カロリー (kcal)</label>
          <input
            className="form-input"
            type="number"
            min="1"
            max="10000"
            value={calories}
            onChange={e => setCalories(e.target.value)}
          />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">メモ</label>
        <textarea
          className="form-input running-textarea"
          maxLength={500}
          rows={3}
          value={memo}
          onChange={e => setMemo(e.target.value)}
        />
      </div>

      <div className="running-edit-actions">
        <button className="btn btn-primary running-inline-btn" type="submit" disabled={submitting}>
          {submitting ? '更新中…' : '更新する'}
        </button>
        <button className="btn btn-secondary running-inline-btn" type="button" onClick={onCancel} disabled={submitting}>
          キャンセル
        </button>
      </div>
    </form>
  )
}

export default function RunningRecords() {
  const [records, setRecords] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [discordRequired, setDiscordRequired] = useState(false)
  const [editingId, setEditingId] = useState(null)
  // 409（楽観ロック競合）発生時の案内。編集・削除どちらでも同じ扱い
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setDiscordRequired(false)
    try {
      const r = await runningApi.get('/v1/records?limit=20')
      setRecords(r.records || [])
      setNextCursor(r.nextCursor || null)
    } catch (e) {
      if (e instanceof RunningApiError && e.status === 403) setDiscordRequired(true)
      else setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function loadMore() {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const r = await runningApi.get(`/v1/records?limit=20&cursor=${encodeURIComponent(nextCursor)}`)
      setRecords(prev => [...prev, ...(r.records || [])])
      setNextCursor(r.nextCursor || null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoadingMore(false)
    }
  }

  function handleSaved(updated) {
    setRecords(prev => prev.map(r => (r.id === updated.id ? updated : r)))
    setEditingId(null)
    setNotice('')
  }

  // 編集・削除どちらでも 409 のときは同じ案内を出し、一覧を再取得する
  function handleConflict() {
    setNotice('他の端末で更新されました。再読み込みしてください')
    setEditingId(null)
    load()
  }

  async function handleDelete(record) {
    if (!window.confirm('この記録を削除しますか？')) return
    try {
      await runningApi.del(`/v1/records/${record.id}?updatedAt=${record.updatedAt}`)
      setRecords(prev => prev.filter(r => r.id !== record.id))
      setNotice('')
    } catch (e) {
      if (e instanceof RunningApiError && e.status === 409) {
        handleConflict()
      } else {
        setError(errMsg(e))
      }
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">📋 記録一覧</h1>
        <p className="page-subtitle">これまでのランニング記録の確認・編集・削除ができます</p>
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

      {!loading && !discordRequired && (
        <div className="card running-card">
          {notice && <div className="alert alert-error">{notice}</div>}
          {error && <p className="running-error">{error}</p>}

          {records.length === 0 ? (
            <p className="running-empty">まだ記録がありません</p>
          ) : (
            <ul className="running-record-list">
              {records.map(r => (
                <li key={r.id} className="running-record-row">
                  {editingId === r.id ? (
                    <EditRow
                      record={r}
                      onSaved={handleSaved}
                      onConflict={handleConflict}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <div className="running-record-item">
                        <span className="running-record-date">{r.runDate}</span>
                        <span className="running-record-distance">{r.distanceKm}km</span>
                        <span className="running-record-duration">{formatDuration(r.durationS)}</span>
                        <span className="running-record-pace">{formatPace(r.paceSPerKm)}/km</span>
                        <span className="running-record-course">{r.course || ''}</span>
                        <div className="running-record-actions">
                          <button className="btn btn-secondary running-inline-btn" onClick={() => setEditingId(r.id)}>
                            編集
                          </button>
                          <button className="btn btn-danger running-inline-btn" onClick={() => handleDelete(r)}>
                            削除
                          </button>
                        </div>
                      </div>

                      {(r.weather || r.heartRate != null || r.calories != null || r.memo) && (
                        <details className="running-record-details">
                          <summary>詳細</summary>
                          <div className="running-record-detail-body">
                            {r.weather && <p>天候: {WEATHER_LABELS[r.weather] || r.weather}</p>}
                            {r.heartRate != null && <p>平均心拍数: {r.heartRate}bpm</p>}
                            {r.calories != null && <p>消費カロリー: {r.calories}kcal</p>}
                            {r.memo && <p>メモ: {r.memo}</p>}
                          </div>
                        </details>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {nextCursor && (
            <button className="btn btn-secondary running-loadmore" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? '読み込み中…' : 'もっと見る'}
            </button>
          )}
        </div>
      )}

      <Link to="/running" className="btn btn-secondary running-back">← ランニングトップへ</Link>
    </>
  )
}
