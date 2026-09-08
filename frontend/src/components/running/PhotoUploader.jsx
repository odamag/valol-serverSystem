import { useState, useRef, useEffect } from 'react'
import runningApi, { RunningApiError } from '../../lib/runningApi.js'

// 記録に写真を添付・差し替えするアップローダー。
// アップロードは契約書（document/running_api.md §5）の3ステップ:
//   1) POST /v1/records/<id>/photo-url  で S3 署名付きPOSTの情報を取得
//   2) 取得した fields を積んだ FormData の最後に file を append して S3 へ直接POST
//      （S3 は別オリジンで署名済みのため credentials は付けない。fields より先に
//        file を積むと S3 が拒否するため、この順序は必ず守ること）
//   3) POST /v1/records/<id>/photo で key を送り、確定した記録を受け取る
//
// AWS側のエンドポイントはまだ実装されておらず 501 を返す。501 が返ってきたときは
// 原因を詮索させず「画像機能はまだ利用できません」とだけ伝える。

const MAX_BYTES = 8 * 1024 * 1024
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp']

// エラーの発生箇所が分かるよう、ステップごとに接頭辞を変えたメッセージを作る
function stepErrMsg(err, prefix) {
  if (err instanceof RunningApiError) {
    if (err.status === 501) return '画像機能はまだ利用できません'
    return `${prefix}: ${err.message}`
  }
  return `${prefix}: 通信エラーが発生しました`
}

export default function PhotoUploader({ recordId, photoUrl, onUploaded }) {
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  // idle | requesting（署名URL取得中） | uploading（S3へ送信中） | finalizing（確定処理中）
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const inputRef = useRef(null)

  // 選び直し・アンマウント時に必ず前のプレビューURLを解放する（解放しないとメモリリークになる）
  useEffect(() => {
    if (!previewUrl) return undefined
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  function handleFileChange(e) {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    setError('')

    if (f.size > MAX_BYTES) {
      setError('画像は8MBまでです')
      e.target.value = ''
      return
    }
    if (!ALLOWED_TYPES.includes(f.type)) {
      setError('PNG / JPEG / WebP の画像を選んでください')
      e.target.value = ''
      return
    }

    setFile(f)
    setPreviewUrl(URL.createObjectURL(f))
  }

  async function handleUpload() {
    if (!file || status !== 'idle') return
    setError('')

    // ステップ1: 署名付きPOSTの情報を取得
    setStatus('requesting')
    let uploadInfo
    try {
      uploadInfo = await runningApi.post(`/v1/records/${recordId}/photo-url`, {
        contentType: file.type,
      })
    } catch (err) {
      setError(stepErrMsg(err, 'アップロード準備に失敗しました'))
      setStatus('idle')
      return
    }

    // ステップ2: S3へ直接POST。fields → file の順で積む
    setStatus('uploading')
    try {
      const formData = new FormData()
      Object.entries(uploadInfo.upload.fields).forEach(([key, value]) => {
        formData.append(key, value)
      })
      formData.append('file', file)

      const res = await fetch(uploadInfo.upload.url, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        // S3のエラーはXMLで返ってくるため、原因調査用にそのまま出しておく
        const body = await res.text().catch(() => '')
        console.error('S3へのアップロードに失敗しました', res.status, body)
        setError('画像のアップロードに失敗しました')
        setStatus('idle')
        return
      }
    } catch (err) {
      console.error('S3へのアップロードに失敗しました', err)
      setError('画像のアップロードに失敗しました')
      setStatus('idle')
      return
    }

    // ステップ3: 確定処理
    setStatus('finalizing')
    try {
      const data = await runningApi.post(`/v1/records/${recordId}/photo`, { key: uploadInfo.key })
      setFile(null)
      setPreviewUrl(null)
      if (inputRef.current) inputRef.current.value = ''
      setStatus('idle')
      onUploaded?.(data.record)
    } catch (err) {
      setError(stepErrMsg(err, 'アップロードの確定に失敗しました'))
      setStatus('idle')
    }
  }

  const busy = status !== 'idle'
  const statusLabel = {
    requesting: 'アップロード準備中…',
    uploading: 'アップロード中…',
    finalizing: '確定中…',
  }[status]

  return (
    <div className="running-photo-uploader">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="running-photo-input"
        onChange={handleFileChange}
        disabled={busy}
      />

      {previewUrl && (
        <img src={previewUrl} alt="選択した写真のプレビュー" className="running-photo-preview" />
      )}

      {error && <div className="alert alert-error running-photo-error">{error}</div>}

      {file && (
        <button
          type="button"
          className="btn btn-primary running-inline-btn"
          onClick={handleUpload}
          disabled={busy}
        >
          {busy ? statusLabel : (photoUrl ? '写真を差し替える' : '写真を追加する')}
        </button>
      )}
    </div>
  )
}
