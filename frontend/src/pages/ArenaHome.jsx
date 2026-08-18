import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import arenaApi from '../lib/arenaApi.js'

export default function ArenaHome() {
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    arenaApi.get('/v1/me')
      .then(data => setIsAdmin(!!data.is_admin))
      .catch(() => setIsAdmin(false))
  }, [])

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">🎴 バンピック</h1>
        <p className="page-subtitle">友人内 1v1 対戦のBAN/PICKとランキング機能です</p>
      </div>

      <div className="card arena-card">
        <div className="arena-home-links">
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

      <div className="card arena-card arena-placeholder">
        <p className="arena-placeholder-title">🚧 対戦作成・ドラフト機能は準備中です</p>
        <p className="arena-placeholder-desc">
          相手選択 → BAN/PICK → 結果申告・ランキング反映までの流れは次のフェーズで追加されます。
          まずは上の「所持ゲーム設定」からゲームを登録しておいてください。
        </p>
      </div>
    </>
  )
}
