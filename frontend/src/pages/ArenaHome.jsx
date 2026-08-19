import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import arenaApi, { ArenaApiError } from '../lib/arenaApi.js'

function errMsg(e) {
  return e instanceof ArenaApiError ? e.message : '通信エラーが発生しました'
}

const STATUS_LABEL = {
  waiting: '対戦相手待ち',
  drafting: 'ドラフト中',
  playing: '対戦中',
  reported: '結果申告中',
  finished: '確定',
  cancelled: '中止',
}

export default function ArenaHome() {
  const navigate = useNavigate()
  const [isAdmin, setIsAdmin] = useState(false)

  const [mode, setMode] = useState('local')
  const [users, setUsers] = useState([])
  const [opponentId, setOpponentId] = useState('')
  const [commonGames, setCommonGames] = useState([])
  const [gamesLoading, setGamesLoading] = useState(false)
  const [gameSlug, setGameSlug] = useState('')
  const [rulesetSlug, setRulesetSlug] = useState('')
  const [bestOf, setBestOf] = useState('1')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)
  const [createdRoom, setCreatedRoom] = useState(null) // オンライン作成直後: {public_id}

  const [joinCode, setJoinCode] = useState('')
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState(null)

  const [matches, setMatches] = useState([])
  const [matchesLoading, setMatchesLoading] = useState(true)

  useEffect(() => {
    arenaApi.get('/v1/me')
      .then(data => setIsAdmin(!!data.is_admin || !!data.admin_bootstrap_available))
      .catch(() => setIsAdmin(false))
    arenaApi.get('/v1/users').then(data => setUsers(data.users)).catch(() => {})
  }, [])

  const loadMatches = useCallback(() => {
    setMatchesLoading(true)
    arenaApi.get('/v1/matches?limit=20')
      .then(data => setMatches(data.matches))
      .catch(() => {})
      .finally(() => setMatchesLoading(false))
  }, [])

  useEffect(() => { loadMatches() }, [loadMatches])

  // ローカル、または相手を指定したオンラインは「両者が所持しているゲーム」だけを候補にする。
  // 相手未指定のオンライン（誰でも参加できる部屋）は、相手がまだ決まっていないので
  // 「自分が所持しているゲーム」を候補にする。
  useEffect(() => {
    if (mode === 'online' && !opponentId) {
      setGamesLoading(true)
      Promise.all([arenaApi.get('/v1/games'), arenaApi.get('/v1/me/games')])
        .then(([allRes, mineRes]) => {
          const mySlugs = new Set(mineRes.games.map(g => g.slug))
          const filtered = allRes.games.filter(g => mySlugs.has(g.slug))
          setCommonGames(filtered)
          setGameSlug(filtered[0] ? filtered[0].slug : '')
        })
        .catch(() => setCommonGames([]))
        .finally(() => setGamesLoading(false))
      return
    }
    if (!opponentId) {
      setCommonGames([])
      setGameSlug('')
      return
    }
    setGamesLoading(true)
    arenaApi.get(`/v1/games?playable_with=${opponentId}`)
      .then(data => {
        setCommonGames(data.games)
        setGameSlug(data.games[0] ? data.games[0].slug : '')
      })
      .catch(() => setCommonGames([]))
      .finally(() => setGamesLoading(false))
  }, [mode, opponentId])

  const selectedGame = commonGames.find(g => g.slug === gameSlug) || null
  const selectedRuleset = selectedGame ? (selectedGame.rulesets.find(r => r.slug === rulesetSlug) || null) : null

  useEffect(() => {
    if (selectedGame) {
      const def = selectedGame.rulesets.find(r => r.is_default) || selectedGame.rulesets[0]
      setRulesetSlug(def ? def.slug : '')
    } else {
      setRulesetSlug('')
    }
  }, [selectedGame])

  function handleModeChange(next) {
    setMode(next)
    setOpponentId('')
    setCreatedRoom(null)
    setCreateError(null)
  }

  async function handleCreate(e) {
    e.preventDefault()
    if (!gameSlug || !rulesetSlug) return
    if (mode === 'local' && !opponentId) return
    setCreating(true)
    setCreateError(null)
    setCreatedRoom(null)
    try {
      const data = await arenaApi.post('/v1/matches', {
        game: gameSlug,
        ruleset: rulesetSlug,
        mode,
        best_of: Number(bestOf),
        ...(opponentId ? { opponent_user_id: Number(opponentId) } : {}),
      })
      if (mode === 'online') {
        // オンラインはすぐ移動せず、ルームコードを見せてから相手と共有できるようにする
        setCreatedRoom(data.match)
        loadMatches()
      } else {
        navigate(`/arena/draft/${data.match.public_id}`)
      }
    } catch (e) {
      setCreateError(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  async function handleJoin(e) {
    e.preventDefault()
    const code = joinCode.trim().toLowerCase()
    if (code === '') return
    setJoining(true)
    setJoinError(null)
    try {
      const data = await arenaApi.post(`/v1/matches/${code}/join`, {})
      navigate(`/arena/draft/${data.match.public_id}`)
    } catch (e) {
      setJoinError(errMsg(e))
    } finally {
      setJoining(false)
    }
  }

  function matchLink(m) {
    return (m.status === 'drafting' || m.status === 'waiting') ? `/arena/draft/${m.public_id}` : `/arena/${m.public_id}`
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎴 バンピック</h1>
        <p className="page-subtitle">友人内 1v1 対戦のBAN/PICKとランキング機能です</p>
      </div>

      <div className="card arena-card">
        <div className="arena-home-links">
          <Link to="/arena/ranking" className="arena-home-link">
            <span className="arena-home-link-icon">🏆</span>
            <span>
              <strong>ランキング</strong>
              <span className="arena-home-link-desc">Elo レーティングとヘッドトゥヘッド</span>
            </span>
          </Link>

          <Link to="/arena/my-games" className="arena-home-link">
            <span className="arena-home-link-icon">✅</span>
            <span>
              <strong>所持ゲーム設定</strong>
              <span className="arena-home-link-desc">対戦候補に出すゲームを選びます</span>
            </span>
          </Link>

          {isAdmin && (
            <Link to="/arena/admin" className="arena-home-link">
              <span className="arena-home-link-icon">🛠️</span>
              <span>
                <strong>ゲームマスタ管理</strong>
                <span className="arena-home-link-desc">ゲーム・エントリー・ルールセットの登録</span>
              </span>
            </Link>
          )}
        </div>
      </div>

      <div className="card arena-card">
        <p className="arena-panel-title">対戦をはじめる</p>

        <div className="arena-mode-tabs">
          <button
            type="button"
            className={`arena-mode-tab${mode === 'local' ? ' arena-mode-tab--active' : ''}`}
            onClick={() => handleModeChange('local')}
          >
            🖥️ ローカル対戦
          </button>
          <button
            type="button"
            className={`arena-mode-tab${mode === 'online' ? ' arena-mode-tab--active' : ''}`}
            onClick={() => handleModeChange('online')}
          >
            🌐 オンライン対戦
          </button>
        </div>

        {mode === 'local' ? (
          <p className="arena-panel-desc">
            同じ画面で交互に操作する「ローカルモード」です。対戦相手を選ぶと、お互いが所持しているゲームだけが選べます。
          </p>
        ) : (
          <p className="arena-panel-desc">
            それぞれ別の端末で対戦する「オンラインモード」です。作成するとルームコードが発行されます。
            相手を指定しなければ、コードを知っている誰でも参加できます。
          </p>
        )}

        {createdRoom ? (
          <div className="arena-room-code-box">
            <p className="arena-panel-subtitle">ルームコードを相手に共有してください</p>
            <p className="arena-room-code">{createdRoom.public_id}</p>
            <div className="arena-form-actions">
              <Link to={`/arena/draft/${createdRoom.public_id}`} className="btn btn-primary arena-inline-btn">
                待機画面を開く
              </Link>
              <button type="button" className="btn btn-secondary arena-inline-btn" onClick={() => setCreatedRoom(null)}>
                別の対戦を作成する
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleCreate}>
            <div className="arena-form-grid">
              <div className="form-group">
                <label className="form-label">対戦相手{mode === 'online' ? '（任意・招待制にする場合のみ）' : ''}</label>
                <select className="form-input" value={opponentId} onChange={e => setOpponentId(e.target.value)} required={mode === 'local'}>
                  <option value="">{mode === 'online' ? '誰でも参加できるようにする' : '選択してください'}</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">ゲーム</label>
                <select
                  className="form-input"
                  value={gameSlug}
                  onChange={e => setGameSlug(e.target.value)}
                  disabled={(mode === 'local' && !opponentId) || gamesLoading || commonGames.length === 0}
                  required
                >
                  {commonGames.length === 0 && <option value="">{mode === 'local' ? '対戦相手を先に選んでください' : '選べるゲームがありません'}</option>}
                  {commonGames.map(g => <option key={g.slug} value={g.slug}>{g.icon || '🎮'} {g.name}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">ルールセット</label>
                <select
                  className="form-input"
                  value={rulesetSlug}
                  onChange={e => setRulesetSlug(e.target.value)}
                  disabled={!selectedGame}
                  required
                >
                  {selectedGame && selectedGame.rulesets.map(r => <option key={r.slug} value={r.slug}>{r.name}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">対戦形式</label>
                <select className="form-input" value={bestOf} onChange={e => setBestOf(e.target.value)}>
                  <option value="1">単発（BO1）</option>
                  <option value="3">2本先取（BO3）</option>
                  <option value="5">3本先取（BO5）</option>
                </select>
              </div>
            </div>

            {selectedRuleset && selectedRuleset.fearless && bestOf !== '1' && (
              <p className="arena-panel-desc arena-fearless-hint">
                🔥 フィアレスルールです。このシリーズで一度PICKされたエントリーは、次のゲーム以降は選べなくなります（BANは引き継ぎません）。
              </p>
            )}

            {mode === 'local' && opponentId && !gamesLoading && commonGames.length === 0 && (
              <p className="arena-empty">
                この相手と共通で所持しているゲームがありません。<Link to="/arena/my-games">所持ゲーム設定</Link>を確認してください。
              </p>
            )}
            {mode === 'online' && !opponentId && !gamesLoading && commonGames.length === 0 && (
              <p className="arena-empty">
                所持ゲームが登録されていません。<Link to="/arena/my-games">所持ゲーム設定</Link>から登録してください。
              </p>
            )}
            {createError && <p className="arena-msg arena-msg--err">{createError}</p>}

            <div className="arena-form-actions">
              <button
                type="submit"
                className="btn btn-primary arena-inline-btn"
                disabled={(mode === 'local' && !opponentId) || !gameSlug || !rulesetSlug || creating}
              >
                {creating ? '作成中…' : (mode === 'online' ? 'ルームを作成する' : 'ドラフトを開始する')}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="card arena-card">
        <p className="arena-panel-title">コードで参加</p>
        <p className="arena-panel-desc">相手から共有されたルームコードを入力して、オンライン対戦に参加します。</p>
        <form className="arena-join-form" onSubmit={handleJoin}>
          <input
            className="form-input arena-join-input"
            placeholder="ルームコード（例: a1b2c3d4）"
            value={joinCode}
            onChange={e => setJoinCode(e.target.value)}
            maxLength={8}
          />
          <button type="submit" className="btn btn-primary arena-inline-btn" disabled={joinCode.trim() === '' || joining}>
            {joining ? '参加中…' : '参加する'}
          </button>
        </form>
        {joinError && <p className="arena-msg arena-msg--err">{joinError}</p>}
      </div>

      <div className="card arena-card">
        <p className="arena-panel-title">進行中・最近の試合</p>
        {matchesLoading && <p className="arena-loading">読み込み中…</p>}
        {!matchesLoading && matches.length === 0 && <p className="arena-empty">まだ試合がありません</p>}
        {!matchesLoading && matches.length > 0 && (
          <ul className="arena-match-list">
            {matches.map(m => (
              <li key={m.public_id} className="arena-match-list-item">
                <Link to={matchLink(m)} className="arena-match-list-link">
                  <span className="arena-match-list-icon">{(m.game && m.game.icon) || '🎮'}</span>
                  <span className="arena-match-list-main">
                    <strong>{m.player_a_name} vs {m.player_b_name || '(相手待ち)'}</strong>
                    <span className="arena-match-list-sub">{m.game && m.game.name}</span>
                  </span>
                  <span className={`arena-badge arena-status-badge--${m.status}`}>{STATUS_LABEL[m.status] || m.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
