// タイトルBAN/PICKの進行帯。
// sequence: [{t:'ban'|'pick', s:'A'|'B'}, ...]（Decider は含まれない）
// actions: [{seq, action, side, game_name, game_icon, is_timeout}, ...]（実行済み分のみ）
// turnIndex: 現在の手番（sequence の添字）
//
// sequence の後ろに Decider の枠を1つ足して表示する。Decider は
// 最後のPICKが終わった時点でサーバーが自動確定するため、actions の最終要素として届く。
export default function DraftTimeline({ sequence, actions, turnIndex }) {
  const bySeq = new Map((actions || []).map(a => [a.seq, a]))
  const deciderSeq = sequence.length
  const decider = bySeq.get(deciderSeq)

  function stepBody(done, isCurrent) {
    if (done) {
      return (
        <span className="arena-timeline-entry">
          <span className="arena-timeline-icon">{done.game_icon || '🎮'}</span>
          <span>{done.game_name}</span>
          {done.is_timeout && <span className="arena-badge arena-badge--muted">自動</span>}
        </span>
      )
    }
    return (
      <span className="arena-timeline-entry arena-timeline-entry--pending">
        {isCurrent ? '選択中…' : '未定'}
      </span>
    )
  }

  return (
    <ol className="arena-timeline">
      {sequence.map((step, i) => {
        const done = bySeq.get(i)
        const isCurrent = i === turnIndex
        const cls = [
          'arena-timeline-step',
          step.t === 'ban' ? 'arena-timeline-step--ban' : 'arena-timeline-step--pick',
          done ? 'arena-timeline-step--done' : '',
          isCurrent ? 'arena-timeline-step--current' : '',
        ].filter(Boolean).join(' ')

        return (
          <li key={i} className={cls}>
            <span className="arena-timeline-label">{step.t === 'ban' ? 'BAN' : 'PICK'} {step.s}</span>
            {stepBody(done, isCurrent)}
          </li>
        )
      })}

      <li className={`arena-timeline-step arena-timeline-step--decider${decider ? ' arena-timeline-step--done' : ''}`}>
        <span className="arena-timeline-label">Decider</span>
        {stepBody(decider, false)}
      </li>
    </ol>
  )
}
