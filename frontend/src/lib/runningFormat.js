// ランニング記録の表示・入力変換の共通ヘルパー。
// 新規作成フォーム（components/running/RecordForm.jsx）と編集フォーム
// （pages/RunningRecords.jsx）の両方から使う。
//
// ここに集約している理由: 時間のパース規約や天候の選択肢は、サーバー側の
// バリデーション（aws/src/lib/validate.ts）と足並みを揃える必要がある。
// 画面ごとに書き写すと、サーバー側を変えたときに片方だけ直し忘れて必ずズレる。

export const WEATHER_OPTIONS = [
  { value: '',       label: '未選択' },
  { value: 'sunny',  label: '晴れ' },
  { value: 'cloudy', label: '曇り' },
  { value: 'rain',   label: '雨' },
  { value: 'snow',   label: '雪' },
  { value: 'windy',  label: '風強い' },
  { value: 'indoor', label: '室内' },
]

// weather の値 → 表示名。未選択(空文字)は含めない
export const WEATHER_LABELS = Object.fromEntries(
  WEATHER_OPTIONS.filter(w => w.value !== '').map(w => [w.value, w.label]),
)

// JST の今日を "YYYY-MM-DD" で返す。
// toISOString() は UTC に変換されてしまい日付がずれることがあるため、
// ローカルの年月日から組み立てる。
export function todayJst() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// "26:30"（mm:ss）または "1:05:12"（hh:mm:ss）を秒に変換する。
// パースできなければ null を返す。
export function parseDurationToSeconds(text) {
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

// 秒数を "mm:ss" / "hh:mm:ss" に整形する。
// 一覧の表示にも、編集フォームの初期値にも同じ形式を使う
// （parseDurationToSeconds で往復できる形にしておく必要があるため）。
export function formatDuration(durationS) {
  const h = Math.floor(durationS / 3600)
  const m = Math.floor((durationS % 3600) / 60)
  const s = durationS % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// サーバーが返す paceSPerKm を "5'06"" に整形する
export function formatPace(paceSPerKm) {
  if (!paceSPerKm) return '—'
  return `${Math.floor(paceSPerKm / 60)}'${String(paceSPerKm % 60).padStart(2, '0')}"`
}

// 入力中のペースのプレビュー。あくまで目安であり、
// 保存される paceSPerKm の正はサーバー側で計算される。
export function paceLabel(distanceKm, durationSec) {
  if (!distanceKm || !durationSec) return '—'
  return formatPace(Math.round(durationSec / distanceKm))
}
