import { useState } from 'react'
import runningApi, { RunningApiError } from '../../lib/runningApi.js'
import { WEATHER_OPTIONS, todayJst, parseDurationToSeconds, paceLabel } from '../../lib/runningFormat.js'

// 時間のパース・天候の選択肢・ペース整形は編集フォームと共有する（lib/runningFormat.js）

export default function RecordForm({ onSubmitted }) {
  const [distanceKm, setDistanceKm] = useState('')
  const [durationText, setDurationText] = useState('')
  const [runDate, setRunDate] = useState(todayJst())
  const [course, setCourse] = useState('')
  const [memo, setMemo] = useState('')
  const [weather, setWeather] = useState('')
  const [heartRate, setHeartRate] = useState('')
  const [calories, setCalories] = useState('')

  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const previewDistance = parseFloat(distanceKm)
  const previewDuration = parseDurationToSeconds(durationText)
  const pace = paceLabel(previewDistance > 0 ? previewDistance : null, previewDuration)

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

    // 未入力の任意項目はキーごと送らない（サーバー側が未知キー・不正値に厳しいため）
    const body = { distanceKm: distance, durationS, runDate }
    if (course.trim()) body.course = course.trim()
    if (memo.trim()) body.memo = memo.trim()
    if (weather) body.weather = weather
    if (heartRate !== '') body.heartRate = Number(heartRate)
    if (calories !== '') body.calories = Number(calories)

    setSubmitting(true)
    try {
      const data = await runningApi.post('/v1/records', body)
      setDistanceKm('')
      setDurationText('')
      setRunDate(todayJst())
      setCourse('')
      setMemo('')
      setWeather('')
      setHeartRate('')
      setCalories('')
      onSubmitted?.(data.record)
    } catch (err) {
      setFormError(err instanceof RunningApiError ? err.message : '通信エラーが発生しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
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
            placeholder="5.2"
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
            placeholder="26:30"
            value={durationText}
            onChange={e => setDurationText(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label">日付</label>
          <input
            className="form-input"
            type="date"
            value={runDate}
            onChange={e => setRunDate(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">コース名</label>
          <input
            className="form-input"
            type="text"
            maxLength={100}
            placeholder="河川敷ループ"
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
      </div>

      <p className="running-pace-preview">
        推定ペース: <strong>{pace}</strong>{pace !== '—' && '/km'}
        <span className="running-muted">（保存時にサーバー側で再計算されます）</span>
      </p>

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

      <details className="running-optional">
        <summary>心拍数・カロリーを入力する（任意）</summary>
        <div className="running-form-grid">
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
      </details>

      <button className="btn btn-primary" type="submit" disabled={submitting}>
        {submitting ? '記録中…' : '記録する'}
      </button>
    </form>
  )
}
