import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'
import SequenceBuilder from '../components/arena/SequenceBuilder.jsx'
import EntryBulkImport from '../components/arena/EntryBulkImport.jsx'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

const EMPTY_GAME_FORM = { slug: '', name: '', entry_label: 'キャラクター', icon: '', sort_order: 0, entry_source: 'manual' }
const EMPTY_RULESET_FORM = { slug: '', name: '', turn_seconds: 30, mirror_allowed: false, fearless: false, is_default: false, sequence: [] }
const EMPTY_ENTRY_FORM = { slug: '', name: '', image_url: '', tags: '' }

// ルート自体は auth.loggedIn だけでガードされているので、ここで GET /v1/me の
// is_admin を見て管理者以外を弾く。サーバー側 requireArenaAdmin() が本体の防御であり、
// これは表示制御にすぎない。
// 注意: arena_admins が空の状態（誰も管理者がいない）でこのゲートを先に評価すると、
// 自己ブートストラップ（最初に管理APIを叩いた人が管理者になる仕組み）を
// フロント側の画面からは起動できなくなる。その場合は一度だけ curl 等で任意の
// /v1/admin/* を叩いて自分を管理者にしてから、この画面を開く運用にする。
export default function ArenaAdmin() {
  const [meState, setMeState] = useState({ loading: true, isAdmin: false })

  useEffect(() => {
    arenaApi.get('/v1/me')
      .then(data => setMeState({ loading: false, isAdmin: !!data.is_admin }))
      .catch(() => setMeState({ loading: false, isAdmin: false }))
  }, [])

  if (meState.loading) {
    return <p className="arena-loading">読み込み中…</p>
  }
  if (!meState.isAdmin) {
    return <Navigate to="/arena" replace />
  }
  return <ArenaAdminContent />
}

function ArenaAdminContent() {
  const [games, setGames] = useState([])
  const [loadingGames, setLoadingGames] = useState(true)
  const [gamesError, setGamesError] = useState(null)
  const [selectedSlug, setSelectedSlug] = useState(null)

  const [showGameForm, setShowGameForm] = useState(false)
  const [gameForm, setGameForm] = useState(EMPTY_GAME_FORM)
  const [gameFormError, setGameFormError] = useState(null)
  const [gameFormBusy, setGameFormBusy] = useState(false)

  const loadGames = useCallback(async () => {
    setLoadingGames(true)
    setGamesError(null)
    try {
      const data = await arenaApi.get('/v1/games')
      setGames(data.games)
    } catch (e) {
      setGamesError(errMsg(e))
    } finally {
      setLoadingGames(false)
    }
  }, [])

  useEffect(() => { loadGames() }, [loadGames])

  const selectedGame = games.find(g => g.slug === selectedSlug) || null

  async function handleCreateGame(e) {
    e.preventDefault()
    setGameFormBusy(true)
    setGameFormError(null)
    try {
      const body = { ...gameForm }
      if (body.slug === '') delete body.slug
      body.sort_order = Number(body.sort_order) || 0
      await arenaApi.post('/v1/admin/games', body)
      setGameForm(EMPTY_GAME_FORM)
      setShowGameForm(false)
      await loadGames()
    } catch (e) {
      setGameFormError(errMsg(e))
    } finally {
      setGameFormBusy(false)
    }
  }

  async function handleDisableGame(slug) {
    if (!confirm(`「${slug}」を無効化しますか？（試合履歴があっても削除はされません）`)) return
    try {
      await arenaApi.del(`/v1/admin/games/${slug}`)
      if (selectedSlug === slug) setSelectedSlug(null)
      await loadGames()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🛠️ ゲームマスタ管理</h1>
        <p className="page-subtitle">ゲーム・エントリー・ルールセットの登録や、APIキー・管理者の管理を行います</p>
      </div>

      <div className="card arena-card">
        <div className="arena-panel-header">
          <h2 className="arena-panel-title">ゲーム一覧</h2>
          <button className="btn btn-secondary arena-inline-btn" onClick={() => setShowGameForm(s => !s)}>
            {showGameForm ? 'キャンセル' : '+ 新規ゲーム'}
          </button>
        </div>

        {showGameForm && (
          <form className="arena-inline-form" onSubmit={handleCreateGame}>
            <div className="arena-form-grid">
              <div className="form-group">
                <label className="form-label">ゲーム名 *</label>
                <input className="form-input" required value={gameForm.name}
                  onChange={e => setGameForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">スラッグ（空なら自動生成）</label>
                <input className="form-input" value={gameForm.slug}
                  placeholder="半角英数字・-・_のみ"
                  onChange={e => setGameForm(f => ({ ...f, slug: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">エントリーの呼び名</label>
                <input className="form-input" value={gameForm.entry_label}
                  onChange={e => setGameForm(f => ({ ...f, entry_label: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">アイコン（絵文字）</label>
                <input className="form-input" value={gameForm.icon}
                  onChange={e => setGameForm(f => ({ ...f, icon: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">表示順</label>
                <input className="form-input" type="number" value={gameForm.sort_order}
                  onChange={e => setGameForm(f => ({ ...f, sort_order: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">エントリー取得方法</label>
                <select className="form-input" value={gameForm.entry_source}
                  onChange={e => setGameForm(f => ({ ...f, entry_source: e.target.value }))}>
                  <option value="manual">手動登録</option>
                  <option value="ddragon">Data Dragon 自動同期（LoL用）</option>
                </select>
              </div>
            </div>
            {gameFormError && <p className="arena-msg arena-msg--err">{gameFormError}</p>}
            <button className="btn btn-primary" type="submit" disabled={gameFormBusy}>
              {gameFormBusy ? '作成中…' : 'ゲームを作成'}
            </button>
          </form>
        )}

        {loadingGames && <p className="arena-loading">読み込み中…</p>}
        {gamesError && <p className="arena-msg arena-msg--err">{gamesError}</p>}

        {!loadingGames && games.length === 0 && <p className="arena-empty">まだゲームがありません。上のボタンから作成してください。</p>}

        {!loadingGames && games.length > 0 && (
          <ul className="arena-game-list">
            {games.map(g => (
              <li key={g.slug} className={`arena-game-list-item${selectedSlug === g.slug ? ' arena-game-list-item--active' : ''}`}>
                <button type="button" className="arena-game-list-btn" onClick={() => setSelectedSlug(g.slug)}>
                  <span className="arena-game-list-icon">{g.icon || '🎮'}</span>
                  <span className="arena-game-list-name">{g.name}</span>
                  <span className="arena-game-list-slug">{g.slug}</span>
                </button>
                <button type="button" className="btn btn-danger arena-inline-btn" onClick={() => handleDisableGame(g.slug)}>
                  無効化
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedGame && (
        <GameDetail
          key={selectedGame.slug}
          game={selectedGame}
          onGameUpdated={loadGames}
        />
      )}

      <ApiKeysPanel />
      <AdminsPanel />
    </>
  )
}

// ── 選択中ゲームの詳細（メタ編集・エントリー・ルールセット・同期/再取込） ─
function GameDetail({ game, onGameUpdated }) {
  const [meta, setMeta] = useState({
    name: game.name, entry_label: game.entry_label, icon: game.icon,
    sort_order: game.sort_order, entry_source: game.entry_source,
  })
  const [metaBusy, setMetaBusy] = useState(false)
  const [metaMsg, setMetaMsg] = useState(null)

  const [entries, setEntries] = useState([])
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [entriesError, setEntriesError] = useState(null)
  const [showEntryForm, setShowEntryForm] = useState(false)
  const [showBulkImport, setShowBulkImport] = useState(false)
  const [entryForm, setEntryForm] = useState(EMPTY_ENTRY_FORM)
  const [entryFormError, setEntryFormError] = useState(null)
  const [entryFormBusy, setEntryFormBusy] = useState(false)
  const [editingEntryId, setEditingEntryId] = useState(null)
  const [editEntryForm, setEditEntryForm] = useState(null)

  const [showRulesetForm, setShowRulesetForm] = useState(false)
  const [rulesetForm, setRulesetForm] = useState(EMPTY_RULESET_FORM)
  const [rulesetFormError, setRulesetFormError] = useState(null)
  const [rulesetFormBusy, setRulesetFormBusy] = useState(false)
  const [editingRulesetId, setEditingRulesetId] = useState(null)
  const [editRulesetForm, setEditRulesetForm] = useState(null)

  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)
  const [reseedBusy, setReseedBusy] = useState(false)
  const [reseedMsg, setReseedMsg] = useState(null)

  const loadEntries = useCallback(async () => {
    setEntriesLoading(true)
    setEntriesError(null)
    try {
      const data = await arenaApi.get(`/v1/games/${game.slug}/entries`)
      setEntries(data.entries)
    } catch (e) {
      setEntriesError(errMsg(e))
    } finally {
      setEntriesLoading(false)
    }
  }, [game.slug])

  useEffect(() => { loadEntries() }, [loadEntries])

  async function handleUpdateMeta(e) {
    e.preventDefault()
    setMetaBusy(true)
    setMetaMsg(null)
    try {
      await arenaApi.patch(`/v1/admin/games/${game.slug}`, {
        ...meta,
        sort_order: Number(meta.sort_order) || 0,
      })
      setMetaMsg({ ok: true, text: '更新しました' })
      await onGameUpdated()
    } catch (e) {
      setMetaMsg({ ok: false, text: errMsg(e) })
    } finally {
      setMetaBusy(false)
    }
  }

  async function handleCreateEntry(e) {
    e.preventDefault()
    setEntryFormBusy(true)
    setEntryFormError(null)
    try {
      const body = { ...entryForm }
      if (body.slug === '') delete body.slug
      await arenaApi.post(`/v1/admin/games/${game.slug}/entries`, body)
      setEntryForm(EMPTY_ENTRY_FORM)
      setShowEntryForm(false)
      await loadEntries()
    } catch (e) {
      setEntryFormError(errMsg(e))
    } finally {
      setEntryFormBusy(false)
    }
  }

  function startEditEntry(entry) {
    setEditingEntryId(entry.id)
    setEditEntryForm({ name: entry.name, image_url: entry.image_url, tags: entry.tags })
  }

  async function handleSaveEntry(id) {
    try {
      await arenaApi.patch(`/v1/admin/entries/${id}`, editEntryForm)
      setEditingEntryId(null)
      setEditEntryForm(null)
      await loadEntries()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  async function handleDisableEntry(id) {
    if (!confirm('このエントリーを無効化しますか？')) return
    try {
      await arenaApi.del(`/v1/admin/entries/${id}`)
      await loadEntries()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  async function handleCreateRuleset(e) {
    e.preventDefault()
    setRulesetFormError(null)
    if (rulesetForm.sequence.length === 0) {
      setRulesetFormError('BAN/PICKの手順を1つ以上追加してください')
      return
    }
    setRulesetFormBusy(true)
    try {
      const body = { ...rulesetForm, turn_seconds: Number(rulesetForm.turn_seconds) || 0 }
      if (body.slug === '') delete body.slug
      await arenaApi.post(`/v1/admin/games/${game.slug}/rulesets`, body)
      setRulesetForm(EMPTY_RULESET_FORM)
      setShowRulesetForm(false)
      await onGameUpdated()
    } catch (e) {
      setRulesetFormError(errMsg(e))
    } finally {
      setRulesetFormBusy(false)
    }
  }

  function startEditRuleset(rs) {
    setEditingRulesetId(rs.id)
    setEditRulesetForm({
      name: rs.name, turn_seconds: rs.turn_seconds, mirror_allowed: rs.mirror_allowed,
      fearless: rs.fearless, is_default: rs.is_default, sequence: rs.sequence,
    })
  }

  async function handleSaveRuleset(id) {
    if (editRulesetForm.sequence.length === 0) {
      alert('BAN/PICKの手順を1つ以上追加してください')
      return
    }
    try {
      await arenaApi.patch(`/v1/admin/rulesets/${id}`, {
        ...editRulesetForm,
        turn_seconds: Number(editRulesetForm.turn_seconds) || 0,
      })
      setEditingRulesetId(null)
      setEditRulesetForm(null)
      await onGameUpdated()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  async function handleDisableRuleset(id) {
    if (!confirm('このルールセットを無効化しますか？')) return
    try {
      await arenaApi.del(`/v1/admin/rulesets/${id}`)
      await onGameUpdated()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  async function handleSync() {
    setSyncBusy(true)
    setSyncMsg(null)
    try {
      const data = await arenaApi.post(`/v1/admin/games/${game.slug}/sync`)
      setSyncMsg({ ok: true, text: `同期しました（バージョン ${data.version} / ${data.count} 件）` })
      await loadEntries()
    } catch (e) {
      setSyncMsg({ ok: false, text: errMsg(e) })
    } finally {
      setSyncBusy(false)
    }
  }

  async function handleReseed() {
    if (!confirm('JSONファイルの内容でこのゲームを再取り込みしますか？（UIで編集した項目は保護されます）')) return
    setReseedBusy(true)
    setReseedMsg(null)
    try {
      const data = await arenaApi.post(`/v1/admin/games/${game.slug}/reseed`)
      setReseedMsg({ ok: true, text: `再取込しました（エントリー ${data.entries} 件 / ルールセット ${data.rulesets} 件）` })
      await loadEntries()
      await onGameUpdated()
    } catch (e) {
      setReseedMsg({ ok: false, text: errMsg(e) })
    } finally {
      setReseedBusy(false)
    }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-panel-title">{game.icon} {game.name} の設定</h2>

      <form className="arena-inline-form" onSubmit={handleUpdateMeta}>
        <div className="arena-form-grid">
          <div className="form-group">
            <label className="form-label">ゲーム名</label>
            <input className="form-input" value={meta.name} onChange={e => setMeta(m => ({ ...m, name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">エントリーの呼び名</label>
            <input className="form-input" value={meta.entry_label} onChange={e => setMeta(m => ({ ...m, entry_label: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">アイコン</label>
            <input className="form-input" value={meta.icon} onChange={e => setMeta(m => ({ ...m, icon: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">表示順</label>
            <input className="form-input" type="number" value={meta.sort_order} onChange={e => setMeta(m => ({ ...m, sort_order: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">エントリー取得方法</label>
            <select className="form-input" value={meta.entry_source} onChange={e => setMeta(m => ({ ...m, entry_source: e.target.value }))}>
              <option value="manual">手動登録</option>
              <option value="ddragon">Data Dragon 自動同期（LoL用）</option>
            </select>
          </div>
        </div>
        <button className="btn btn-secondary" type="submit" disabled={metaBusy}>{metaBusy ? '更新中…' : '基本情報を更新'}</button>
        {metaMsg && <p className={`arena-msg ${metaMsg.ok ? 'arena-msg--ok' : 'arena-msg--err'}`}>{metaMsg.text}</p>}
      </form>

      <div className="arena-admin-actions">
        {game.entry_source === 'ddragon' && (
          <button className="btn btn-secondary" onClick={handleSync} disabled={syncBusy}>
            {syncBusy ? '同期中…' : '⚔️ Data Dragon から同期'}
          </button>
        )}
        <button className="btn btn-secondary" onClick={handleReseed} disabled={reseedBusy}>
          {reseedBusy ? '再取込中…' : '📄 JSONから再取り込み（上書き）'}
        </button>
      </div>
      {syncMsg && <p className={`arena-msg ${syncMsg.ok ? 'arena-msg--ok' : 'arena-msg--err'}`}>{syncMsg.text}</p>}
      {reseedMsg && <p className={`arena-msg ${reseedMsg.ok ? 'arena-msg--ok' : 'arena-msg--err'}`}>{reseedMsg.text}</p>}

      {/* ── エントリー ── */}
      <div className="arena-subsection">
        <div className="arena-panel-header">
          <h3 className="arena-panel-subtitle">{game.entry_label}一覧（{entries.length}）</h3>
          <div className="arena-panel-header-actions">
            <button className="btn btn-secondary arena-inline-btn" onClick={() => setShowEntryForm(s => !s)}>
              {showEntryForm ? 'キャンセル' : '+ 1件追加'}
            </button>
            <button className="btn btn-secondary arena-inline-btn" onClick={() => setShowBulkImport(s => !s)}>
              {showBulkImport ? 'キャンセル' : '📋 一括インポート'}
            </button>
          </div>
        </div>

        {showEntryForm && (
          <form className="arena-inline-form" onSubmit={handleCreateEntry}>
            <div className="arena-form-grid">
              <div className="form-group">
                <label className="form-label">名前 *</label>
                <input className="form-input" required value={entryForm.name}
                  onChange={e => setEntryForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">スラッグ（空なら自動生成）</label>
                <input className="form-input" value={entryForm.slug}
                  onChange={e => setEntryForm(f => ({ ...f, slug: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">画像URL</label>
                <input className="form-input" value={entryForm.image_url}
                  onChange={e => setEntryForm(f => ({ ...f, image_url: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">タグ</label>
                <input className="form-input" value={entryForm.tags}
                  onChange={e => setEntryForm(f => ({ ...f, tags: e.target.value }))} />
              </div>
            </div>
            {entryFormError && <p className="arena-msg arena-msg--err">{entryFormError}</p>}
            <button className="btn btn-primary" type="submit" disabled={entryFormBusy}>
              {entryFormBusy ? '追加中…' : '追加'}
            </button>
          </form>
        )}

        {showBulkImport && (
          <EntryBulkImport gameSlug={game.slug} onImported={() => { setShowBulkImport(false); loadEntries() }} />
        )}

        {entriesLoading && <p className="arena-loading">読み込み中…</p>}
        {entriesError && <p className="arena-msg arena-msg--err">{entriesError}</p>}

        {!entriesLoading && entries.length === 0 && <p className="arena-empty">まだエントリーがありません。</p>}

        {!entriesLoading && entries.length > 0 && (
          <ul className="arena-entry-list">
            {entries.map(entry => (
              <li key={entry.id} className="arena-entry-item">
                {editingEntryId === entry.id ? (
                  <div className="arena-entry-edit">
                    <input className="form-input" value={editEntryForm.name}
                      onChange={e => setEditEntryForm(f => ({ ...f, name: e.target.value }))} />
                    <input className="form-input" placeholder="画像URL" value={editEntryForm.image_url}
                      onChange={e => setEditEntryForm(f => ({ ...f, image_url: e.target.value }))} />
                    <input className="form-input" placeholder="タグ" value={editEntryForm.tags}
                      onChange={e => setEditEntryForm(f => ({ ...f, tags: e.target.value }))} />
                    <div className="arena-entry-edit-actions">
                      <button className="btn btn-primary arena-inline-btn" onClick={() => handleSaveEntry(entry.id)}>保存</button>
                      <button className="btn btn-secondary arena-inline-btn" onClick={() => setEditingEntryId(null)}>キャンセル</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {entry.image_url && <img className="arena-entry-thumb" src={entry.image_url} alt="" />}
                    <span className="arena-entry-name">{entry.name}</span>
                    <span className="arena-entry-slug">{entry.slug}</span>
                    <span className="arena-entry-actions">
                      <button className="btn btn-secondary arena-inline-btn" onClick={() => startEditEntry(entry)}>編集</button>
                      <button className="btn btn-danger arena-inline-btn" onClick={() => handleDisableEntry(entry.id)}>無効化</button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── ルールセット ── */}
      <div className="arena-subsection">
        <div className="arena-panel-header">
          <h3 className="arena-panel-subtitle">ルールセット一覧（{game.rulesets.length}）</h3>
          <button className="btn btn-secondary arena-inline-btn" onClick={() => setShowRulesetForm(s => !s)}>
            {showRulesetForm ? 'キャンセル' : '+ 新規ルールセット'}
          </button>
        </div>

        {showRulesetForm && (
          <form className="arena-inline-form" onSubmit={handleCreateRuleset}>
            <div className="arena-form-grid">
              <div className="form-group">
                <label className="form-label">名前 *</label>
                <input className="form-input" required value={rulesetForm.name}
                  onChange={e => setRulesetForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">スラッグ（空なら自動生成）</label>
                <input className="form-input" value={rulesetForm.slug}
                  onChange={e => setRulesetForm(f => ({ ...f, slug: e.target.value }))} />
              </div>
              <div className="form-group">
                <label className="form-label">持ち時間（秒・0=無制限）</label>
                <input className="form-input" type="number" min="0" max="600" value={rulesetForm.turn_seconds}
                  onChange={e => setRulesetForm(f => ({ ...f, turn_seconds: e.target.value }))} />
              </div>
            </div>
            <div className="arena-checkbox-row">
              <label><input type="checkbox" checked={rulesetForm.mirror_allowed}
                onChange={e => setRulesetForm(f => ({ ...f, mirror_allowed: e.target.checked }))} /> 相手と同じエントリーを許可</label>
              <label><input type="checkbox" checked={rulesetForm.fearless}
                onChange={e => setRulesetForm(f => ({ ...f, fearless: e.target.checked }))} /> フィアレス（シリーズ内で再選択不可）</label>
              <label><input type="checkbox" checked={rulesetForm.is_default}
                onChange={e => setRulesetForm(f => ({ ...f, is_default: e.target.checked }))} /> デフォルトにする</label>
            </div>
            <label className="form-label">BAN/PICK 手順</label>
            <SequenceBuilder value={rulesetForm.sequence} onChange={seq => setRulesetForm(f => ({ ...f, sequence: seq }))} />
            {rulesetFormError && <p className="arena-msg arena-msg--err">{rulesetFormError}</p>}
            <button className="btn btn-primary" type="submit" disabled={rulesetFormBusy}>
              {rulesetFormBusy ? '作成中…' : 'ルールセットを作成'}
            </button>
          </form>
        )}

        {game.rulesets.length === 0 && <p className="arena-empty">まだルールセットがありません。</p>}

        {game.rulesets.length > 0 && (
          <ul className="arena-ruleset-list">
            {game.rulesets.map(rs => (
              <li key={rs.id} className="arena-ruleset-item">
                {editingRulesetId === rs.id ? (
                  <div className="arena-ruleset-edit">
                    <div className="arena-form-grid">
                      <div className="form-group">
                        <label className="form-label">名前</label>
                        <input className="form-input" value={editRulesetForm.name}
                          onChange={e => setEditRulesetForm(f => ({ ...f, name: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">持ち時間（秒）</label>
                        <input className="form-input" type="number" min="0" max="600" value={editRulesetForm.turn_seconds}
                          onChange={e => setEditRulesetForm(f => ({ ...f, turn_seconds: e.target.value }))} />
                      </div>
                    </div>
                    <div className="arena-checkbox-row">
                      <label><input type="checkbox" checked={editRulesetForm.mirror_allowed}
                        onChange={e => setEditRulesetForm(f => ({ ...f, mirror_allowed: e.target.checked }))} /> ミラー許可</label>
                      <label><input type="checkbox" checked={editRulesetForm.fearless}
                        onChange={e => setEditRulesetForm(f => ({ ...f, fearless: e.target.checked }))} /> フィアレス</label>
                      <label><input type="checkbox" checked={editRulesetForm.is_default}
                        onChange={e => setEditRulesetForm(f => ({ ...f, is_default: e.target.checked }))} /> デフォルト</label>
                    </div>
                    <SequenceBuilder value={editRulesetForm.sequence} onChange={seq => setEditRulesetForm(f => ({ ...f, sequence: seq }))} />
                    <div className="arena-entry-edit-actions">
                      <button className="btn btn-primary arena-inline-btn" onClick={() => handleSaveRuleset(rs.id)}>保存</button>
                      <button className="btn btn-secondary arena-inline-btn" onClick={() => setEditingRulesetId(null)}>キャンセル</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="arena-ruleset-summary">
                      <strong>{rs.name}</strong>
                      {rs.is_default && <span className="arena-badge">デフォルト</span>}
                      <span className="arena-ruleset-meta">
                        {rs.turn_seconds > 0 ? `${rs.turn_seconds}秒` : '無制限'} / {rs.sequence.length}手
                      </span>
                    </div>
                    <div className="arena-seq-mini-preview">
                      {rs.sequence.map((s, i) => (
                        <span key={i} className={`arena-seq-chip ${s.t === 'ban' ? 'arena-step-ban' : 'arena-step-pick'}`}>
                          {s.t === 'ban' ? 'BAN' : 'PICK'} {s.s}
                        </span>
                      ))}
                    </div>
                    <span className="arena-entry-actions">
                      <button className="btn btn-secondary arena-inline-btn" onClick={() => startEditRuleset(rs)}>編集</button>
                      <button className="btn btn-danger arena-inline-btn" onClick={() => handleDisableRuleset(rs.id)}>無効化</button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── APIキー管理 ─────────────────────────────────────────────────
function ApiKeysPanel() {
  const [keys, setKeys] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await arenaApi.get('/v1/admin/keys')
      setKeys(data.keys)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e) {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    setIssued(null)
    try {
      const data = await arenaApi.post('/v1/admin/keys', { name: name.trim() })
      setIssued(data.key)
      setName('')
      await load()
    } catch (e) {
      alert(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRevoke(id) {
    if (!confirm('このキーを失効させますか？')) return
    try {
      await arenaApi.del(`/v1/admin/keys/${id}`)
      await load()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-panel-title">🔑 APIキー（Discordボット用）</h2>

      {issued && (
        <div className="arena-key-issued">
          <p><strong>この画面でのみ表示されます。今すぐ控えてください。</strong></p>
          <code className="arena-key-value">{issued}</code>
        </div>
      )}

      <form className="arena-inline-form arena-key-form" onSubmit={handleCreate}>
        <input className="form-input" placeholder="キーの用途（例: discord-bot）" value={name}
          onChange={e => setName(e.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? '発行中…' : '発行'}
        </button>
      </form>

      {loading && <p className="arena-loading">読み込み中…</p>}
      {error && <p className="arena-msg arena-msg--err">{error}</p>}

      {!loading && keys.length === 0 && <p className="arena-empty">発行済みのキーはありません。</p>}

      {!loading && keys.length > 0 && (
        <ul className="arena-key-list">
          {keys.map(k => (
            <li key={k.id} className="arena-key-item">
              <span className="arena-key-name">{k.name}</span>
              {k.revoked_at ? (
                <span className="arena-badge arena-badge--muted">失効済み</span>
              ) : (
                <button className="btn btn-danger arena-inline-btn" onClick={() => handleRevoke(k.id)}>失効</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── 管理者管理 ───────────────────────────────────────────────────
function AdminsPanel() {
  const [admins, setAdmins] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedUserId, setSelectedUserId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [adminsRes, usersRes] = await Promise.all([
        arenaApi.get('/v1/admin/admins'),
        arenaApi.get('/v1/users'),
      ])
      setAdmins(adminsRes.admins)
      setUsers(usersRes.users)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const adminIds = new Set(admins.map(a => a.user_id))
  const candidates = users.filter(u => !adminIds.has(u.id))

  async function handleAdd(e) {
    e.preventDefault()
    if (!selectedUserId) return
    setBusy(true)
    try {
      const user = users.find(u => String(u.id) === String(selectedUserId))
      await arenaApi.post('/v1/admin/admins', { user_id: Number(selectedUserId), username: user?.username ?? '' })
      setSelectedUserId('')
      await load()
    } catch (e) {
      alert(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(userId) {
    if (!confirm('この管理者を削除しますか？')) return
    try {
      await arenaApi.del(`/v1/admin/admins/${userId}`)
      await load()
    } catch (e) {
      alert(errMsg(e))
    }
  }

  return (
    <div className="card arena-card">
      <h2 className="arena-panel-title">👑 管理者</h2>

      {loading && <p className="arena-loading">読み込み中…</p>}
      {error && <p className="arena-msg arena-msg--err">{error}</p>}

      {!loading && (
        <>
          <ul className="arena-admin-list">
            {admins.map(a => (
              <li key={a.user_id} className="arena-admin-item">
                <span>{a.username || `ユーザー#${a.user_id}`}</span>
                <button className="btn btn-danger arena-inline-btn" onClick={() => handleRemove(a.user_id)}
                  disabled={admins.length <= 1}>
                  削除
                </button>
              </li>
            ))}
          </ul>

          {candidates.length > 0 && (
            <form className="arena-inline-form arena-key-form" onSubmit={handleAdd}>
              <select className="form-input" value={selectedUserId} onChange={e => setSelectedUserId(e.target.value)}>
                <option value="">ユーザーを選択…</option>
                {candidates.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
              <button className="btn btn-primary" type="submit" disabled={busy || !selectedUserId}>
                {busy ? '追加中…' : '管理者に追加'}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}
