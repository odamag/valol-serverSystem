import { useEffect, useState } from 'react'

// turn_deadline（unix秒）からのカウントダウン表示。
// 判定は常にサーバー側（arenaApplyTimeouts）が行うため、これは見た目だけ。
// クライアント時計のズレやポーリング間隔の分だけ実際の失効タイミングとずれ得る。
export default function TurnTimer({ deadline }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    if (!deadline) return undefined
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 250)
    return () => clearInterval(id)
  }, [deadline])

  if (!deadline) return null

  const remaining = Math.max(0, deadline - now)
  const urgent = remaining <= 5

  return (
    <span className={`arena-turn-timer${urgent ? ' arena-turn-timer--urgent' : ''}`}>
      ⏱ 残り {remaining} 秒
    </span>
  )
}
