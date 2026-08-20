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

  // 編集中の行。null なら誰も編集していない。
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState(EMPTY_GAME)
  const [editBusy, setEditBusy] = useState(false)

  // 一覧の絞り込み。既定は「有効のみ」（普段いじるのは有効なタイトルなので）
  const [showDisabled, setShowDisabled] = useState(false)

  // 無効なタイトルも編集・再有効化したいので、管理画面では全件取得する
  const load = useCallback(async () => {
    try {
      const d = await arenaApi.get('/v1/admin/games')
      setGames(d.games || [])
    } catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  const enabledCount = games.filter(g => g.enabled).length
  const defaultCount = games.filter(g => g.enabled && g.is_default).length
  const visible = showDisabled ? games : games.filter(g => g.enabled)

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

  function startEdit(g) {
    setEditingId(g.id)
    setEditForm({ slug: g.slug, name: g.name, icon: g.icon || '', sort_order: g.sort_order })
    setError(null)
  }

  async function saveEdit(e, original) {
    e.preventDefault()
    setEditBusy(true); setError(null)
    try {
      // slug は URL に使うので、変更されたときだけ送る（無変更なら触らない）
      const body = {
        name: editForm.name,
        icon: editForm.icon,
        sort_order: Number(editForm.sort_order) || 0,
      }
      if (editForm.slug && editForm.slug !== original.slug) body.slug = editForm.slug
      await arenaApi.patch(`/v1/admin/games/${original.slug}`, body)
      setEditingId(null)
      await load()
    } catch (e) { setError(errMsg(e)) } finally { setEditBusy(false) }
  }

  async function setDefault(g, isDefault) {
    setError(null)
    try { await arenaApi.patch(`/v1/admin/games/${g.slug}`, { is_default: isDefault }); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  async function setEnabled(g, enabled) {
    if (!enabled && !window.confirm(`${g.name} を無効にしますか？（対戦履歴は残ります）`)) return
    setError(null)
    try { await arenaApi.patch(`/v1/admin/games/${g.slug}`, { enabled }); await load() }
    catch (e) { setError(errMsg(e)) }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">🎮 ゲームタイトル</h2>
      <p className="arena-muted">
        BAN/PICK の対象になるタイトルです。シリーズを始めるには
        <strong>有効なタイトルが書式の pool_size（既定 9）ぶん</strong>必要です。
        現在 有効 {enabledCount} 件 / 全 {games.length} 件。
      </p>
      <p className="arena-muted">
        <strong>デフォルト</strong>に設定したタイトルは、シリーズ作成時に最初から選択された状態になります。
        現在 {defaultCount} 件（書式の pool_size とそろえておくと、そのまま作成できます）。
      </p>
      {error && <p className="arena-error">{error}</p>}

      <h3 className="arena-subsection-title">タイトルを追加</h3>
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

      <div className="arena-list-head">
        <h3 className="arena-subsection-title">登録済みのタイトル</h3>
        <label className="arena-filter-toggle">
          <input
            type="checkbox"
            checked={!showDisabled}
            onChange={e => setShowDisabled(!e.target.checked)}
          />
          <span>有効のみ表示</span>
        </label>
      </div>
      <ul className="arena-admin-list">
        {visible.length === 0 && (
          <li><span className="arena-muted">表示できるタイトルがありません。</span></li>
        )}
        {visible.map(g => (
          <li key={g.id} className={g.enabled ? '' : 'arena-admin-item--disabled'}>
            {editingId === g.id ? (
              <form className="arena-edit-form" onSubmit={e => saveEdit(e, g)}>
                <input
                  className="arena-edit-icon"
                  value={editForm.icon}
                  onChange={e => setEditForm(f => ({ ...f, icon: e.target.value }))}
                  maxLength={4}
                  placeholder="🎮"
                  aria-label="アイコン"
                />
                <input
                  className="arena-edit-name"
                  value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  required
                  aria-label="タイトル名"
                />
                <input
                  className="arena-edit-slug"
                  value={editForm.slug}
                  onChange={e => setEditForm(f => ({ ...f, slug: e.target.value }))}
                  aria-label="スラッグ"
                />
                <input
                  className="arena-edit-order"
                  type="number"
                  value={editForm.sort_order}
                  onChange={e => setEditForm(f => ({ ...f, sort_order: e.target.value }))}
                  aria-label="並び順"
                />
                <button className="btn btn-primary" disabled={editBusy || !editForm.name}>保存</button>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingId(null)}>
                  やめる
                </button>
              </form>
            ) : (
              <>
                <span>
                  {g.icon || '🎮'} <strong>{g.name}</strong>{' '}
                  <span className="arena-muted">{g.slug}</span>
                  {g.is_default && <span className="arena-badge">デフォルト</span>}
                  {!g.enabled && <span className="arena-badge arena-badge--muted">無効</span>}
                </span>
                <span className="arena-admin-actions">
                  <button
                    className={g.is_default ? 'btn btn-secondary' : 'btn btn-secondary'}
                    onClick={() => setDefault(g, !g.is_default)}
                  >
                    {g.is_default ? 'デフォルト解除' : 'デフォルトにする'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => startEdit(g)}>編集</button>
                  {g.enabled
                    ? <button className="btn btn-danger" onClick={() => setEnabled(g, false)}>無効化</button>
                    : <button className="btn btn-secondary" onClick={() => setEnabled(g, true)}>有効化</button>}
                </span>
              </>
            )}
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

  // 既定の書式はシリーズ作成画面で最初に選ばれる。サーバー側で常に1つだけになる。
  async function makeDefault(id) {
    setError(null)
    try { await arenaApi.patch(`/v1/admin/formats/${id}`, { is_default: true }); await load() }
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
              {f.is_default && <span className="arena-badge">デフォルト</span>}
              {!f.enabled && <span className="arena-badge arena-badge--muted">無効</span>}
            </span>
            <span className="arena-admin-actions">
              {!f.is_default && f.enabled && (
                <button className="btn btn-secondary" onClick={() => makeDefault(f.id)}>デフォルトにする</button>
              )}
              <button className="btn btn-danger" onClick={() => disable(f.id)}>無効化</button>
            </span>
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

// ── シーズン（表示ランクの配置期間） ──────────────────────────
function SeasonPanel() {
  const [season, setSeason] = useState(null)
  const [form, setForm] = useState(null)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await arenaApi.get('/v1/seasons/current')
      setSeason(d.season)
      setForm({
        name: d.season.name,
        placement_games: d.season.placement_games,
        offset_max: d.season.offset_max,
        compress_ratio: d.season.compress_ratio,
      })
    } catch (e) { setError(errMsg(e)) }
  }, [])
  useEffect(() => { load() }, [load])

  async function save(e) {
    e.preventDefault()
    setBusy(true); setError(null); setSaved(false)
    try {
      await arenaApi.patch('/v1/admin/seasons/current', {
        name: form.name,
        placement_games: Number(form.placement_games),
        offset_max: Number(form.offset_max),
        compress_ratio: Number(form.compress_ratio),
      })
      await load()
      setSaved(true)
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  async function startNew(e) {
    e.preventDefault()
    if (!window.confirm(
      `新シーズン「${newName}」を開始します。\n\n` +
      `・全員の内部レートが平均値方向へ ${season.compress_ratio} 倍に圧縮されます\n` +
      `・全員の配置期間がリセットされます\n\n` +
      'この操作は取り消せません。よろしいですか？'
    )) return
    setBusy(true); setError(null)
    try {
      await arenaApi.post('/v1/admin/seasons', { name: newName })
      setNewName('')
      await load()
    } catch (e) { setError(errMsg(e)) } finally { setBusy(false) }
  }

  if (!season || !form) return null

  const decay = form.placement_games > 0 ? (form.offset_max / form.placement_games) : 0

  return (
    <div className="card arena-card">
      <h2 className="arena-section-title">📅 シーズンと配置期間</h2>
      <p className="arena-muted">
        内部レート（Elo）は常に通常どおり動きます。配置期間中だけ<strong>表示ランク</strong>を
        <code>内部レート − max(0, (N − シーズン内試合数) × 減衰係数)</code> で低く抑え、
        N 戦に達した時点でランクを確定させます。
      </p>
      <p className="arena-muted">
        抑制は1戦ごとに減衰係数ぶん解けるため、<strong>配置期間中は負けても表示ランクが上がることがあります</strong>
        （格上に負けてレートの下がり幅が減衰係数より小さいとき）。内部レートは常に通常のEloどおりに動きます。
      </p>
      {error && <p className="arena-error">{error}</p>}

      <form onSubmit={save}>
        <div className="arena-form-grid">
          <label className="arena-field">
            <span>シーズン名</span>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
          </label>
          <label className="arena-field">
            <span>配置試合数 N</span>
            <input type="number" min="0" max="200" value={form.placement_games}
                   onChange={e => setForm(f => ({ ...f, placement_games: e.target.value }))} />
          </label>
          <label className="arena-field">
            <span>OFFSET_MAX</span>
            <input type="number" min="0" max="2000" value={form.offset_max}
                   onChange={e => setForm(f => ({ ...f, offset_max: e.target.value }))} />
          </label>
          <label className="arena-field">
            <span>次シーズンへの圧縮率</span>
            <input type="number" min="0" max="1" step="0.05" value={form.compress_ratio}
                   onChange={e => setForm(f => ({ ...f, compress_ratio: e.target.value }))} />
          </label>
        </div>
        <p className="arena-muted">
          減衰係数 = OFFSET_MAX ÷ N = <strong>{decay.toFixed(2)}</strong>
          （1戦目の抑制幅は最大 {Number(form.offset_max) || 0}）
        </p>
        <button className="btn btn-primary" disabled={busy}>{saved ? '保存しました' : '設定を保存'}</button>
      </form>

      <h3 className="arena-subsection-title">新シーズンを開始</h3>
      <p className="arena-muted">
        内部レートを平均値方向へ圧縮して引き継ぎ（新レート = 平均 + (旧レート − 平均) × {season.compress_ratio}）、
        全員の配置期間をリセットします。
      </p>
      <form className="arena-join-row" onSubmit={startNew}>
        <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="新しいシーズン名" />
        <button className="btn btn-danger" disabled={busy || !newName.trim()}>シーズンを切り替える</button>
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
      <SeasonPanel />
      <SettingsPanel />
      <KeysPanel />
      <AdminsPanel />

      <Link to="/arena" className="btn btn-secondary arena-back">← バンピックトップへ</Link>
    </>
  )
}
