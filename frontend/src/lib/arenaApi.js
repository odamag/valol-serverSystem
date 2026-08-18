// Arena API 用の共通 fetch ラッパ。
// 本番ではサブディレクトリの .htaccess によるリライトで /api/arena/v1/... を
// 直接叩けるが、PHPビルトインサーバー（.htaccessを読まない）やリライトが
// 効かない環境向けのフォールバックとして index.php?path=... 形式も選べるようにする。
// 切り替えは下の定数1つだけで行う。
const ARENA_USE_PATH_FALLBACK = true

const ARENA_REWRITE_BASE = '/api/arena/v1'
const ARENA_FALLBACK_BASE = '/api/arena/index.php'

// path は "/v1/games" や "/v1/games?playable_with=3" のように必ず /v1 から始まる。
// フォールバック時はクエリ文字列を分離し、?path=<パス本体>&<残りのクエリ> の形にする
// （すべてまとめて path= に詰めると PHP 側の $_GET が個別のクエリを拾えなくなるため）。
function buildUrl(path) {
  if (!ARENA_USE_PATH_FALLBACK) {
    return path.replace(/^\/v1/, ARENA_REWRITE_BASE)
  }
  const qIndex = path.indexOf('?')
  const pathOnly = qIndex === -1 ? path : path.slice(0, qIndex)
  const query = qIndex === -1 ? '' : path.slice(qIndex + 1)
  const params = new URLSearchParams(query)
  params.set('path', pathOnly)
  return `${ARENA_FALLBACK_BASE}?${params.toString()}`
}

// Arena API 呼び出しの共通エラー。サーバーが返した日本語メッセージを保持する。
export class ArenaApiError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.name = 'ArenaApiError'
    this.status = status
    this.payload = payload
  }
}

// path: "/v1/games" のようなAPIパス。opts: fetchのオプション（method, bodyなど）
async function arenaRequest(path, opts = {}) {
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
    throw new ArenaApiError('通信エラーが発生しました', 0, null)
  }

  if (res.status === 304) {
    return null
  }

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
    throw new ArenaApiError(message, res.status, data)
  }

  return data
}

export const arenaApi = {
  get: (path) => arenaRequest(path, { method: 'GET' }),
  post: (path, body) => arenaRequest(path, { method: 'POST', body: body ?? {} }),
  patch: (path, body) => arenaRequest(path, { method: 'PATCH', body: body ?? {} }),
  put: (path, body) => arenaRequest(path, { method: 'PUT', body: body ?? {} }),
  del: (path) => arenaRequest(path, { method: 'DELETE' }),
  // 一括インポートなど、生のテキストボディを送りたい場合用（JSONエンコードしない）
  postRaw: (path, rawBody) => arenaRequest(path, { method: 'POST', body: rawBody, headers: { 'Content-Type': 'text/plain' } }),
}

export default arenaApi
