// Running API 用の共通 fetch ラッパ。arenaApi.js の複製。
// 呼び出し側は "/v1/..." のパスを渡し、ここで /api/v1/running/... に変換する。
const RUNNING_BASE = '/api/v1/running'

// path は "/v1/records" や "/v1/records?limit=5" のように必ず /v1 から始まる。
// Rust 側は /api/v1/running/<X> をそのまま AWS の /v1/<X> へ中継する。
function buildUrl(path) {
  return path.replace(/^\/v1/, RUNNING_BASE)
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
