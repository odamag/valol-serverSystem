import { useState, useEffect, useCallback } from 'react'
import { Navigate, Link } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'
import SequenceBuilder from '../components/arena/SequenceBuilder.jsx'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

const EMPTY_GAME = { slug: '', name: '', icon: '', sort_order: 0 }
const EMPTY_FORMAT = { slug: '', name: '', wins_needed: 3, turn_seconds: 0, sequence: [] }

// ── ゲームタイトル管理 ────────────────────────────────────────
function GamesPanel() {
  const [games, setGames] = useState([])
  const [form, setForm] = useState(EMPTY_GAME)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await arenaApi.get('/v1/games')
      setGames(d.games || [])
    } catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  async function create(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const body = { name: form.name, icon: form.icon, sort_order: Number(form.sort_order) || 0 }
      if (form.slug) body.slug = form.slug
      await arenaApi.post('/v1/admin/games', body)
      setForm(EMPTY_GAME)
      await load()
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  async function disable(slug) {
    if (!window.confirm(`${slug} を無効にしますか？（履歴は残ります）`)) return
    try { await arenaApi.del(`/v1/admin/games/${slug}`); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">🎮 ゲームタイトル</h2>
      <p className="arena-muted">
        BAN/PICK の対象になるタイトルです。書式の pool_size（既定 9）ぶん必要です。現在 {games.length} 件。
      </p>
      {error && <p className="arena-error">{error}</p>}

      <form className="arena-form-grid" onSubmit={create}>
        <label className="arena-field">
          <span>タイトル名</span>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
        </label>
        <label className="arena-field">
          <span>アイコン（絵文字）</span>
          <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} maxLength={4} />
        </label>
        <label className="arena-field">
          <span>スラッグ<span className="arena-muted">（空なら自動）</span></span>
          <input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} />
        </label>
        <label className="arena-field">
          <span>並び順</span>
          <input type="number" value={form.sort_order}
                 onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} />
        </label>
        <button className="btn btn-primary" disabled={busy || !form.name}>追加</button>
      </form>

      <ul className="arena-admin-list">
        {games.map(g => (
          <li key={g.id}>
            <span>{g.icon || '🎮'} <strong>{g.name}</strong> <span className="arena-muted">{g.slug}</span></span>
            <button className="btn btn-danger" onClick={() => disable(g.slug)}>無効化</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── ドラフト書式管理 ──────────────────────────────────────────
function FormatsPanel() {
  const [formats, setFormats] = useState([])
  const [form, setForm] = useState(EMPTY_FORMAT)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await arenaApi.get('/v1/admin/formats')
      setFormats(d.formats || [])
    } catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  // pool_size は「手数 + 1（Decider）」で自動的に決まる
  const poolSize = form.sequence.length + 1
  const gamesInSeries = form.sequence.filter(s => s.t === 'pick').length + 1

  async function create(e) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await arenaApi.post('/v1/admin/formats', {
        slug: form.slug || undefined,
        name: form.name,
        sequence: form.sequence,
        pool_size: poolSize,
        wins_needed: Number(form.wins_needed),
        turn_seconds: Number(form.turn_seconds) || 0,
      })
      setForm(EMPTY_FORMAT)
      await load()
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  async function disable(id) {
    if (!window.confirm('この書式を無効にしますか？')) return
    try { await arenaApi.del(`/v1/admin/formats/${id}`); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">📋 ドラフト書式</h2>
      <p className="arena-muted">
        BAN/PICK の手順です。最後に残った 1 タイトルが自動的に Decider（最終試合）になるため、
        必要なタイトル数は「手数 + 1」になります。
      </p>
      {error && <p className="arena-error">{error}</p>}

      <form onSubmit={create}>
        <div className="arena-form-grid">
          <label className="arena-field">
            <span>書式名</span>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          </label>
          <label className="arena-field">
            <span>何勝で決着</span>
            <input type="number" min="1" value={form.wins_needed}
                   onChange={e => setForm(f => ({ ...f, wins_needed: e.target.value }))} />
          </label>
          <label className="arena-field">
            <span>手番の制限時間（秒・0で無制限）</span>
            <input type="number" min="0" max="600" value={form.turn_seconds}
                   onChange={e => setForm(f => ({ ...f, turn_seconds: e.target.value }))} />
          </label>
        </div>

        <SequenceBuilder value={form.sequence} onChange={seq => setForm(f => ({ ...f, sequence: seq }))} />

        <p className="arena-muted">
          必要タイトル数 <strong>{poolSize}</strong> ・ 試合数 <strong>{gamesInSeries}</strong>
          （PICK {gamesInSeries - 1} + Decider 1）
        </p>

        <button className="btn btn-primary" disabled={busy || !form.name || form.sequence.length === 0}>
          書式を追加
        </button>
      </form>

      <ul className="arena-admin-list">
        {formats.map(f => (
          <li key={f.id}>
            <span>
              <strong>{f.name}</strong> <span className="arena-muted">{f.slug}</span>
              <span className="arena-muted"> / {f.pool_size}タイトル / {f.wins_needed}先取</span>
              {!f.enabled && <span className="arena-badge arena-badge--muted">無効</span>}
            </span>
            <button className="btn btn-danger" onClick={() => disable(f.id)}>無効化</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── APIキー（Discordボット用） ────────────────────────────────
function KeysPanel() {
  const [keys, setKeys] = useState([])
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState('read')
  const [issued, setIssued] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { const d = await arenaApi.get('/v1/admin/keys'); setKeys(d.keys || []) }
    catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  async function create(e) {
    e.preventDefault()
    setError(null)
    try {
      const d = await arenaApi.post('/v1/admin/keys', { name, scopes })
      setIssued(d.key || d.raw_key)
      setName('')
      await load()
    } catch (e) { setError(errMsg(e)) }
  }

  async function revoke(id) {
    if (!window.confirm('このキーを失効させますか？')) return
    try { await arenaApi.del(`/v1/admin/keys/${id}`); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">🔑 APIキー（Discordボット用）</h2>
      <p className="arena-muted">
        キーは対戦データの読み書きのみに使えます。管理APIには通りません。
      </p>
      {error && <p className="arena-error">{error}</p>}

      {issued && (
        <div className="arena-notice">
          発行されたキー（この画面を離れると二度と表示できません）
          <code className="arena-key-value">{issued}</code>
        </div>
      )}

      <form className="arena-form-grid" onSubmit={create}>
        <label className="arena-field">
          <span>用途名</span>
          <input value={name} onChange={e => setName(e.target.value)} required />
        </label>
        <label className="arena-field">
          <span>権限</span>
          <select value={scopes} onChange={e => setScopes(e.target.value)}>
            <option value="read">読み取りのみ</option>
            <option value="read,write">読み書き</option>
          </select>
        </label>
        <button className="btn btn-primary" disabled={!name}>発行</button>
      </form>

      <ul className="arena-admin-list">
        {keys.map(k => (
          <li key={k.id}>
            <span>
              <strong>{k.name}</strong> <span className="arena-muted">{k.scopes}</span>
              {k.revoked_at && <span className="arena-badge arena-badge--muted">失効済み</span>}
            </span>
            {!k.revoked_at && <button className="btn btn-danger" onClick={() => revoke(k.id)}>失効</button>}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 管理者 ────────────────────────────────────────────────────
function AdminsPanel() {
  const [admins, setAdmins] = useState([])
  const [users, setUsers] = useState([])
  const [pick, setPick] = useState('')
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [a, u] = await Promise.all([
        arenaApi.get('/v1/admin/admins'),
        arenaApi.get('/v1/users'),
      ])
      setAdmins(a.admins || [])
      setUsers(u.users || [])
    } catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  async function add(e) {
    e.preventDefault()
    try { await arenaApi.post('/v1/admin/admins', { user_id: Number(pick) }); setPick(''); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  async function remove(id) {
    if (!window.confirm('この管理者を削除しますか？')) return
    try { await arenaApi.del(`/v1/admin/admins/${id}`); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">👤 管理者</h2>
      {error && <p className="arena-error">{error}</p>}
      <form className="arena-form-grid" onSubmit={add}>
        <label className="arena-field">
          <span>追加するユーザー</span>
          <select value={pick} onChange={e => setPick(e.target.value)} required>
            <option value="">選択してください</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </select>
        </label>
        <button className="btn btn-primary" disabled={!pick}>管理者にする</button>
      </form>
      <ul className="arena-admin-list">
        {admins.map(a => (
          <li key={a.user_id}>
            <span><strong>{a.username}</strong></span>
            <button className="btn btn-danger" onClick={() => remove(a.user_id)}>削除</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── 設定 ──────────────────────────────────────────────────────
function SettingsPanel() {
  const [threshold, setThreshold] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    arenaApi.get('/v1/admin/settings')
      .then(d => setThreshold(String(d.settings.side_choice_threshold)))
      .catch(e => setError(errMsg(e)))
  }, [])

  async function save(e) {
    e.preventDefault()
    setError(null); setSaved(false)
    try {
      const d = await arenaApi.patch('/v1/admin/settings', {
        side_choice_threshold: Number(threshold),
      })
      setThreshold(String(d.settings.side_choice_threshold))
      setSaved(true)
    } catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">⚖️ 先手後手の決め方</h2>
      <p className="arena-muted">
        シリーズレート（5番勝負のElo）の差がこの値<strong>以内</strong>なら互角とみなしてルーレット、
        超えていればレートが低いほうが先行・後行を選べます。
      </p>
      {error && <p className="arena-error">{error}</p>}
      <form className="arena-form-grid" onSubmit={save}>
        <label className="arena-field">
          <span>同点とみなすレート差</span>
          <input type="number" min="0" max="1000" step="1"
                 value={threshold} onChange={e => { setThreshold(e.target.value); setSaved(false) }} />
        </label>
        <button className="btn btn-primary" disabled={threshold === ''}>
          {saved ? '保存しました' : '保存'}
        </button>
      </form>
    </div>
  )
}

// ── ページ本体 ────────────────────────────────────────────────
// arena_admins が空のうちは admin_bootstrap_available が true になり、この画面を開ける。
// ロリポップ ライトプランには SSH が無く CLI を叩けないため、最初の管理者は
// 必ず Web 画面から登録できる必要がある。実際の登録は、この画面で最初の
// 管理APIを叩いた時点でサーバー側の requireArenaAdmin() が行う。
export default function ArenaAdmin() {
  const [me, setMe] = useState({ loading: true, isAdmin: false, canBootstrap: false })

  useEffect(() => {
    arenaApi.get('/v1/me')
      .then(d => setMe({
        loading: false,
        isAdmin: !!d.is_admin,
        canBootstrap: !!d.admin_bootstrap_available,
      }))
      .catch(() => setMe({ loading: false, isAdmin: false, canBootstrap: false }))
  }, [])

  if (me.loading) return <p className="arena-loading">読み込み中…</p>
  if (!me.isAdmin && !me.canBootstrap) return <Navigate to="/arena" replace />

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🛠️ タイトル・書式の管理</h1>
        <p className="page-subtitle">BAN/PICK の対象タイトルとドラフト書式を登録します</p>
      </div>

      {!me.isAdmin && me.canBootstrap && (
        <div className="arena-notice">
          まだ管理者が登録されていません。この画面で最初の操作を行うと、
          あなたが最初の管理者として登録されます。
        </div>
      )}

      <GamesPanel />
      <FormatsPanel />
      <SettingsPanel />
      <KeysPanel />
      <AdminsPanel />

      <Link to="/arena" className="btn btn-secondary arena-back">← バンピックトップへ</Link>
    </>
  )
}
