// BAN/PICKの進行帯。
// sequence: [{t:'ban'|'pick', s:'A'|'B'}, ...]
// actions: [{seq, action, side, entry_name, entry_image_url, is_timeout}, ...]（実行済み分のみ）
// currentIndex: 現在の手番（sequence の添字）
export default function DraftTimeline({ sequence, actions, currentIndex }) {
  const bySeq = new Map(actions.map(a => [a.seq, a]))

  return (
    <ol className="arena-timeline">
      {sequence.map((step, i) => {
        const done = bySeq.get(i)
        const isCurrent = i === currentIndex
        const cls = [
          'arena-timeline-step',
          step.t === 'ban' ? 'arena-timeline-step--ban' : 'arena-timeline-step--pick',
          done ? 'arena-timeline-step--done' : '',
          isCurrent ? 'arena-timeline-step--current' : '',
        ].filter(Boolean).join(' ')

        return (
          <li key={i} className={cls}>
            <span className="arena-timeline-label">{step.t === 'ban' ? 'BAN' : 'PICK'} {step.s}</span>
            {done ? (
              <span className="arena-timeline-entry">
                {done.entry_image_url && <img src={done.entry_image_url} alt="" />}
                <span>{done.entry_name || '（自動選択なし）'}</span>
                {done.is_timeout && <span className="arena-badge arena-badge--muted">自動</span>}
              </span>
            ) : (
              <span className="arena-timeline-entry arena-timeline-entry--pending">
                {isCurrent ? '選択中…' : '未定'}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}
