import { LOLIPOP_INCIDENT_PATH } from './notices/LolipopIncident2026.jsx'

const infoLinks = [
  {
    href: 'https://www.notion.so/Minecraft-Server-2fcb31a2feb68015b9f5fc19b6cf793f?source=copy_link',
    icon: '📓',
    title: 'Minecraft サーバー情報',
    description: 'サーバーのルール・設定・MODなどをまとめたノーションページ。',
  },
]

export default function Info() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">📋 情報</h1>
        <p className="page-subtitle">サーバーやゲームに関する情報リンク集</p>
      </div>

      <section className="notice-section">
        <h2 className="notice-section-title">📢 お知らせ</h2>
        {/* 合言葉の外に置いたページなので、ルーターの中の遷移ではなく普通のリンクで開く */}
        <a href={LOLIPOP_INCIDENT_PATH} className="notice-link">
          <span className="notice-date">2026年11月27日</span>
          <span className="notice-link-title">ロリポップ!レンタルサーバーの不正アクセスについて</span>
        </a>
      </section>

      <div className="games-grid">
        {infoLinks.map(link => (
          <a
            key={link.href}
            href={link.href}
            className="game-card"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="game-icon">{link.icon}</span>
            <span className="game-title">{link.title}</span>
            <span className="game-description">{link.description}</span>
            <span className="game-tag">外部リンク</span>
          </a>
        ))}
      </div>
    </>
  )
}
