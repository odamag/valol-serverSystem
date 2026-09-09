// Running API 用の共通 fetch ラッパ。arenaApi.js の複製。
// 本番ではサブディレクトリの .htaccess によるリライトで /api/running/v1/... を
// 直接叩けるが、PHPビルトインサーバー（.htaccessを読まない）やリライトが
// 効かない環境向けのフォールバックとして index.php?path=... 形式も選べるようにする。
// 切り替えは下の定数1つだけで行う。
const RUNNING_USE_PATH_FALLBACK = true

const RUNNING_REWRITE_BASE = '/api/running/v1'
const RUNNING_FALLBACK_BASE = '/api/running/index.php'

// path は "/v1/records" や "/v1/records?limit=5" のように必ず /v1 から始まる。
// フォールバック時はクエリ文字列を分離し、?path=<パス本体>&<残りのクエリ> の形にする
// （すべてまとめて path= に詰めると PHP 側の $_GET が個別のクエリを拾えなくなるため）。
function buildUrl(path) {
  if (!RUNNING_USE_PATH_FALLBACK) {
    return path.replace(/^\/v1/, RUNNING_REWRITE_BASE)
  }
  const qIndex = path.indexOf('?')
  const pathOnly = qIndex === -1 ? path : path.slice(0, qIndex)
  const query = qIndex === -1 ? '' : path.slice(qIndex + 1)
  const params = new URLSearchParams(query)
  params.set('path', pathOnly)
  return `${RUNNING_FALLBACK_BASE}?${params.toString()}`
}

// Running API 呼び出しの共通エラー。サーバーが返した日本語メッセージを保持する。
export class RunningApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'RunningApiError'
    this.status = status
    this.payload = payload
  }
}

// path: "/v1/records" のようなAPIパス。opts: fetchのオプション（method, bodyなど）
async function runningRequest(path, opts = {}) {
  const headers = { ...(opts.headers || {}) }
  let body = opts.body
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body)
    headers['Content-Type'] = 'application/json'
  }

  let res
  try {
    res = await fetch(buildUrl(path), {
      ...opts,
      body,
      headers,
      credentials: 'include',
    })
  } catch (e) {
    throw new RunningApiError('通信エラーが発生しました', 0, null)
  }

  // 304 の特別扱いは不要: arena はポーリング（If-None-Match 等）で使うが、
  // running には該当する差分ポーリング機能が無いため常に本文を読む。

  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch (e) {
      data = null
    }
  }

  if (!res.ok || !data || data.success === false) {
    const message = (data && data.message) || `エラーが発生しました (HTTP ${res.status})`
    throw new RunningApiError(message, res.status, data)
  }

  return data
}

export const runningApi = {
  get: (path) => runningRequest(path, { method: 'GET' }),
  post: (path, body) => runningRequest(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => runningRequest(path, { method: 'PATCH', body: body ?? {} }),
  del: (path) => runningRequest(path, { method: 'DELETE' }),
}

export default runningApi
