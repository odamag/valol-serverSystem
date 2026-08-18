import { useState, useMemo } from 'react'
import arenaApi, { ArenaApiError } from '../../lib/arenaApi.js'

// 改行区切りの名前を貼り付け → プレビュー → 一括投入。
// gameSlug: 対象ゲームのスラッグ。onImported: (count) => void（投入成功時に呼ばれる）
export default function EntryBulkImport({ gameSlug, onImported }) {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const names = useMemo(() => {
    return text
      .split(/\r\n|\r|\n/)
      .map(s => s.trim())
      .filter(s => s !== '')
  }, [text])

  async function handleImport() {
    if (names.length === 0) return
    setSubmitting(true)
    setError(null)
    setResult(null)
    try {
      const data = await arenaApi.postRaw(`/v1/admin/games/${gameSlug}/entries/import`, text)
      setResult(data.imported)
      setText('')
      onImported?.(data.imported)
    } catch (e) {
      setError(e instanceof ArenaApiError ? e.message : '通信エラーが発生しました')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="arena-bulk-import">
      <p className="arena-bulk-hint">1行に1件、キャラクター名などを貼り付けてください。</p>
      <textarea
        className="form-input arena-bulk-textarea"
        rows={6}
        placeholder={'リュウ\nケン\n春麗'}
        value={text}
        onChange={e => { setText(e.target.value); setResult(null); setError(null) }}
        disabled={submitting}
      />
      <div className="arena-bulk-footer">
        <span className="arena-bulk-count">{names.length} 件を検出</span>
        <button
          type="button"
          className="btn btn-primary arena-bulk-submit"
          disabled={names.length === 0 || submitting}
          onClick={handleImport}
        >
          {submitting ? '投入中…' : `${names.length} 件をインポート`}
        </button>
      </div>
      {names.length > 0 && (
        <ul className="arena-bulk-preview">
          {names.slice(0, 30).map((n, i) => <li key={i}>{n}</li>)}
          {names.length > 30 && <li className="arena-bulk-more">…他 {names.length - 30} 件</li>}
        </ul>
      )}
      {error && <p className="arena-msg arena-msg--err">{error}</p>}
      {result !== null && <p className="arena-msg arena-msg--ok">{result} 件をインポートしました</p>}
    </div>
  )
}
