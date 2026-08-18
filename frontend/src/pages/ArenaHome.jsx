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

  const [users, setUsers] = useState([])
  const [opponentId, setOpponentId] = useState('')
  const [commonGames, setCommonGames] = useState([])
  const [gamesLoading, setGamesLoading] = useState(false)
  const [gameSlug, setGameSlug] = useState('')
  const [rulesetSlug, setRulesetSlug] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState(null)

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

  useEffect(() => {
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
  }, [opponentId])

  const selectedGame = commonGames.find(g => g.slug === gameSlug) || null

  useEffect(() => {
    if (selectedGame) {
      const def = selectedGame.rulesets.find(r => r.is_default) || selectedGame.rulesets[0]
      setRulesetSlug(def ? def.slug : '')
    } else {
      setRulesetSlug('')
    }
  }, [selectedGame])

  async function handleCreate(e) {
    e.preventDefault()
    if (!opponentId || !gameSlug || !rulesetSlug) return
    setCreating(true)
    setCreateError(null)
    try {
      const data = await arenaApi.post('/v1/matches', {
        game: gameSlug,
        ruleset: rulesetSlug,
        mode: 'local',
        opponent_user_id: Number(opponentId),
      })
      navigate(`/arena/draft/${data.match.public_id}`)
    } catch (e) {
      setCreateError(errMsg(e))
    } finally {
      setCreating(false)
    }
  }

  function matchLink(m) {
    return m.status === 'drafting' ? `/arena/draft/${m.public_id}` : `/arena/${m.public_id}`
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
        <p className="arena-panel-title">対戦をはじめる（ローカル対戦）</p>
        <p className="arena-panel-desc">
          同じ画面で交互に操作する「ローカルモード」です。対戦相手を選ぶと、お互いが所持しているゲームだけが選べます。
        </p>

        <form onSubmit={handleCreate}>
          <div className="arena-form-grid">
            <div className="form-group">
              <label className="form-label">対戦相手</label>
              <select className="form-input" value={opponentId} onChange={e => setOpponentId(e.target.value)} required>
                <option value="">選択してください</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">ゲーム</label>
              <select
                className="form-input"
                value={gameSlug}
                onChange={e => setGameSlug(e.target.value)}
                disabled={!opponentId || gamesLoading || commonGames.length === 0}
                required
              >
                {commonGames.length === 0 && <option value="">対戦相手を先に選んでください</option>}
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
          </div>

          {opponentId && !gamesLoading && commonGames.length === 0 && (
            <p className="arena-empty">
              この相手と共通で所持しているゲームがありません。<Link to="/arena/my-games">所持ゲーム設定</Link>を確認してください。
            </p>
          )}
          {createError && <p className="arena-msg arena-msg--err">{createError}</p>}

          <div className="arena-form-actions">
            <button
              type="submit"
              className="btn btn-primary arena-inline-btn"
              disabled={!opponentId || !gameSlug || !rulesetSlug || creating}
            >
              {creating ? '作成中…' : 'ドラフトを開始する'}
            </button>
          </div>
        </form>
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
                    <strong>{m.player_a_name} vs {m.player_b_name}</strong>
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
