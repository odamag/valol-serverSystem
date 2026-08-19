import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

// 9タイトルのプールを選ぶ。既定は「両者が所持しているタイトル」。
// 書式の pool_size ちょうどでないとサーバー側が 400 を返すため、
// 過不足を画面上でも分かるようにしておく。
function PoolPicker({ games, selected, onToggle, poolSize, onResetDefault }) {
  const diff = selected.size - poolSize
  const hasDefaults = games.some(g => g.is_default)
  return (
    <div className="arena-pool-picker">
      <p className={`arena-pool-count${diff === 0 ? ' arena-pool-count--ok' : ''}`}>
        選択中 {selected.size} / {poolSize}
        {diff > 0 && `（${diff} 個多いです）`}
        {diff < 0 && `（あと ${-diff} 個）`}
        {hasDefaults && (
          <button type="button" className="arena-link-btn" onClick={onResetDefault}>
            デフォルトに戻す
          </button>
        )}
      </p>
      <div className="arena-title-grid">
        {games.map(g => (
          <button
            key={g.id}
            type="button"
            className={`arena-title-card${selected.has(g.slug) ? ' arena-title-card--selected' : ''}`}
            onClick={() => onToggle(g.slug)}
          >
            <span className="arena-title-icon">{g.icon || '🎮'}</span>
            <span className="arena-title-name">{g.name}</span>
            {g.is_default && <span className="arena-title-mark">デフォルト</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ArenaHome() {
  const navigate = useNavigate()

  const [me, setMe] = useState(null)
  const [users, setUsers] = useState([])
  const [formats, setFormats] = useState([])
  const [games, setGames] = useState([])

  const [mode, setMode] = useState('local')
  const [opponent, setOpponent] = useState('')
  const [formatSlug, setFormatSlug] = useState('')
  const [selected, setSelected] = useState(new Set())

  const [mySeries, setMySeries] = useState([])
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([
      arenaApi.get('/v1/me'),
      arenaApi.get('/v1/users'),
      arenaApi.get('/v1/formats'),
      arenaApi.get('/v1/series'),
    ])
      .then(([m, u, f, s]) => {
        setMe(m)
        setUsers(u.users || [])
        setFormats(f.formats || [])
        setMySeries(s.series || [])
        const def = (f.formats || []).find(x => x.is_default) || (f.formats || [])[0]
        if (def) setFormatSlug(def.slug)
      })
      .catch(e => setError(errMsg(e)))
  }, [])

  // 候補タイトルを読み込み、初期選択を決める。
  // 相手が決まっていれば「両者が所持しているタイトル」に絞る。
  // 初期選択は管理画面で「デフォルト」に設定されたタイトル。
  // デフォルトが1つも無い（＝未設定）ときだけ、候補すべてを選んだ状態にする。
  const loadGames = useCallback(async (opponentId) => {
    try {
      const path = opponentId ? `/v1/games?playable_with=${opponentId}` : '/v1/games'
      const data = await arenaApi.get(path)
      const list = data.games || []
      setGames(list)
      const defaults = list.filter(g => g.is_default)
      setSelected(new Set((defaults.length > 0 ? defaults : list).map(g => g.slug)))
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  useEffect(() => { loadGames(opponent || null) }, [opponent, loadGames])

  const format = formats.find(f => f.slug === formatSlug)
  const poolSize = format ? format.pool_size : 9

  function toggle(slug) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  async function createSeries() {
    setBusy(true)
    setError(null)
    try {
      const body = {
        format: formatSlug,
        mode,
        game_slugs: Array.from(selected),
      }
      if (opponent) body.opponent_user_id = Number(opponent)
      const data = await arenaApi.post('/v1/series', body)
      navigate(`/arena/${data.series.public_id}`)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    setBusy(true)
    setError(null)
    try {
      await arenaApi.post(`/v1/series/${joinCode.trim()}/join`, {})
      navigate(`/arena/${joinCode.trim()}`)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const canCreate = formatSlug && selected.size === poolSize &&
    (mode === 'online' || opponent) && !busy

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎴 バンピック</h1>
        <p className="page-subtitle">
          {poolSize} タイトルから BAN / PICK して、5番勝負の対戦カードを決めます
        </p>
      </div>

      {error && <p className="arena-error">{error}</p>}

      <div className="card arena-card">
        <h2 className="arena-section-title">新しいシリーズを始める</h2>

        <div className="arena-mode-tabs">
          <button
            className={`arena-mode-tab${mode === 'local' ? ' active' : ''}`}
            onClick={() => setMode('local')}
          >1画面で交互に</button>
          <button
            className={`arena-mode-tab${mode === 'online' ? ' active' : ''}`}
            onClick={() => setMode('online')}
          >それぞれの端末から</button>
        </div>

        <div className="arena-form-grid">
          <label className="arena-field">
            <span>対戦相手{mode === 'online' && <span className="arena-muted">（任意・指定すると招待制）</span>}</span>
            <select value={opponent} onChange={e => setOpponent(e.target.value)}>
              <option value="">{mode === 'online' ? '誰でも参加可' : '選択してください'}</option>
              {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
            </select>
          </label>

          <label className="arena-field">
            <span>書式</span>
            <select value={formatSlug} onChange={e => setFormatSlug(e.target.value)}>
              {formats.map(f => (
                <option key={f.slug} value={f.slug}>
                  {f.name}（{f.pool_size}タイトル / {f.wins_needed}先取）
                </option>
              ))}
            </select>
          </label>
        </div>

        {format && (
          <p className="arena-seq-preview">
            {format.sequence.map((s, i) => (
              <span key={i} className={`arena-step-badge arena-step-${s.t}`}>
                {s.t === 'ban' ? 'BAN' : 'PICK'} {s.s}
              </span>
            ))}
            <span className="arena-step-badge arena-step-decider">Decider</span>
          </p>
        )}

        <h3 className="arena-subsection-title">タイトルプール</h3>
        <PoolPicker
          games={games}
          selected={selected}
          onToggle={toggle}
          poolSize={poolSize}
          onResetDefault={() => {
            const defaults = games.filter(g => g.is_default)
            setSelected(new Set((defaults.length > 0 ? defaults : games).map(g => g.slug)))
          }}
        />

        <button className="btn btn-primary" disabled={!canCreate} onClick={createSeries}>
          {busy ? '作成中…' : 'シリーズを作成'}
        </button>
      </div>

      {mode === 'online' && (
        <div className="card arena-card">
          <h2 className="arena-section-title">コードで参加</h2>
          <div className="arena-join-row">
            <input
              value={joinCode}
              onChange={e => setJoinCode(e.target.value)}
              placeholder="8文字のコード"
              maxLength={8}
            />
            <button className="btn btn-secondary" disabled={!joinCode.trim() || busy} onClick={join}>
              参加する
            </button>
          </div>
        </div>
      )}

      {mySeries.length > 0 && (
        <div className="card arena-card">
          <h2 className="arena-section-title">進行中・最近のシリーズ</h2>
          <ul className="arena-series-list">
            {mySeries.slice(0, 10).map(s => (
              <li key={s.public_id}>
                <Link to={`/arena/${s.public_id}`}>
                  <span className="arena-series-code">{s.public_id}</span>
                  <span className="arena-series-status">{s.status}</span>
                  <span>{s.player1_name} vs {s.player2_name || '（募集中）'}</span>
                  <span className="arena-muted">{s.wins_a} - {s.wins_b}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card arena-card">
        <div className="arena-home-links">
          <Link to="/arena/my-games" className="arena-home-link">
            <span className="arena-home-link-icon">✅</span>
            <span><strong>所持タイトル設定</strong>
              <span className="arena-home-link-desc">対戦候補に出すタイトルを選びます</span></span>
          </Link>
          <Link to="/arena/ranking" className="arena-home-link">
            <span className="arena-home-link-icon">🏆</span>
            <span><strong>ランキング・統計</strong>
              <span className="arena-home-link-desc">タイトル別 / 総合 / シリーズ別のレート</span></span>
          </Link>
          {me && (me.is_admin || me.admin_bootstrap_available) && (
            <Link to="/arena/admin" className="arena-home-link">
              <span className="arena-home-link-icon">🛠️</span>
              <span><strong>タイトル・書式の管理</strong>
                <span className="arena-home-link-desc">ゲームタイトルとドラフト書式の登録</span></span>
            </Link>
          )}
        </div>
      </div>
    </>
  )
}
