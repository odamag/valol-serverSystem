const games = [
  {
    href: '/games/minigame/',
    icon: '⚔️',
    title: 'Auto Battle RPG',
    description: '眺めて楽しむオートバトルRPG。キャラクターが自動で戦います。',
    tag: 'シングルプレイ',
  },
  {
    href: '/games/pong/',
    icon: '🏓',
    title: 'Pong (P2P)',
    description: '友達とP2P接続してリアルタイムで対戦するポンゲーム。',
    tag: '2プレイヤー',
  },
  {
    href: '/games/linegame/',
    icon: '🎯',
    title: 'ライン通過ゲーム',
    description: '障害物を避けながらラインを通過するアクションゲーム。',
    tag: '2プレイヤー',
  },
]

export default function MiniGames() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎮 ミニゲーム</h1>
        <p className="page-subtitle">ゲームを選んで遊んでみよう！</p>
      </div>

      <div className="games-grid">
        {games.map(game => (
          <a
            key={game.href}
            href={game.href}
            className="game-card"
            target={game.external ? '_blank' : '_self'}
            rel={game.external ? 'noopener noreferrer' : undefined}
          >
            <span className="game-icon">{game.icon}</span>
            <span className="game-title">{game.title}</span>
            <span className="game-description">{game.description}</span>
            <span className="game-tag">{game.tag}</span>
          </a>
        ))}
      </div>
    </>
  )
}
