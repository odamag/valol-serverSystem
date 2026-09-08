import { useState } from 'react'
import runningApi, { RunningApiError } from '../../lib/runningApi.js'

const WEATHER_OPTIONS = [
  { value: '',       label: '未選択' },
  { value: 'sunny',  label: '晴れ' },
  { value: 'cloudy', label: '曇り' },
  { value: 'rain',   label: '雨' },
  { value: 'snow',   label: '雪' },
  { value: 'windy',  label: '風強い' },
  { value: 'indoor', label: '室内' },
]

// JST の今日を "YYYY-MM-DD" で返す。
// new Date() のローカル時刻は JST 前提でよいが、toISOString() は UTC に
// 変換されてしまい日付がずれることがあるため、ローカルの年月日から組み立てる。
function todayJst() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// "26:30"（mm:ss）または "1:05:12"（hh:mm:ss）を秒に変換する。
// パースできなければ null を返す。
function parseDurationToSeconds(text) {
  const parts = text.trim().split(':')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (!parts.every(p => /^\d{1,3}$/.test(p))) return null
  const nums = parts.map(Number)
  if (parts.length === 2) {
    const [mm, ss] = nums
    if (ss > 59) return null
    return mm * 60 + ss
  }
  const [hh, mm, ss] = nums
  if (mm > 59 || ss > 59) return null
  return hh * 3600 + mm * 60 + ss
}

// ペースの表示用プレビュー。あくまで入力中の目安であり、
// 保存される値（paceSPerKm）の正はサーバー側で計算される。
function paceLabel(distanceKm, durationSec) {
  if (!distanceKm || !durationSec) return '—'
  const s = Math.round(durationSec / distanceKm)
  return `${Math.floor(s / 60)}'${String(s % 60).padStart(2, '0')}"`
}

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
