// ルールセットの BAN/PICK 手順を目で組み立てるエディタ。
// JSON を手打ちさせず、ボタンで積み上げ・並べ替え・削除できるようにする。
// value: [{t:'ban'|'pick', s:'A'|'B'}, ...]  onChange: (nextValue) => void

const STEP_LABEL = {
  ban_A:  { label: 'BAN A',  cls: 'arena-step-ban' },
  ban_B:  { label: 'BAN B',  cls: 'arena-step-ban' },
  pick_A: { label: 'PICK A', cls: 'arena-step-pick' },
  pick_B: { label: 'PICK B', cls: 'arena-step-pick' },
}

function stepKey(step) {
  return `${step.t}_${step.s}`
}

export default function SequenceBuilder({ value, onChange }) {
  const steps = Array.isArray(value) ? value : []

  function append(t, s) {
    onChange([...steps, { t, s }])
  }

  function removeAt(index) {
    onChange(steps.filter((_, i) => i !== index))
  }

  function moveAt(index, dir) {
    const target = index + dir
    if (target < 0 || target >= steps.length) return
    const next = [...steps]
    const tmp = next[index]
    next[index] = next[target]
    next[target] = tmp
    onChange(next)
  }

  function clearAll() {
    onChange([])
  }

  return (
    <div className="arena-seq-builder">
      <div className="arena-seq-add-row">
        <button type="button" className="btn btn-secondary arena-seq-add-btn" onClick={() => append('ban', 'A')}>
          + BAN A
        </button>
        <button type="button" className="btn btn-secondary arena-seq-add-btn" onClick={() => append('ban', 'B')}>
          + BAN B
        </button>
        <button type="button" className="btn btn-secondary arena-seq-add-btn" onClick={() => append('pick', 'A')}>
          + PICK A
        </button>
        <button type="button" className="btn btn-secondary arena-seq-add-btn" onClick={() => append('pick', 'B')}>
          + PICK B
        </button>
      </div>

      <div className="arena-seq-preview">
        {steps.length === 0 ? (
          <p className="arena-seq-empty">上のボタンで手順を追加してください（例: BAN A → BAN B → PICK A → PICK B）</p>
        ) : (
          <ol className="arena-seq-list">
            {steps.map((step, i) => {
              const meta = STEP_LABEL[stepKey(step)] ?? { label: `${step.t} ${step.s}`, cls: '' }
              return (
                <li key={i} className="arena-seq-item">
                  <span className="arena-seq-index">{i + 1}</span>
                  <span className={`arena-seq-chip ${meta.cls}`}>{meta.label}</span>
                  <span className="arena-seq-item-actions">
                    <button
                      type="button"
                      className="arena-seq-mini-btn"
                      disabled={i === 0}
                      onClick={() => moveAt(i, -1)}
                      title="上へ"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="arena-seq-mini-btn"
                      disabled={i === steps.length - 1}
                      onClick={() => moveAt(i, 1)}
                      title="下へ"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="arena-seq-mini-btn arena-seq-mini-btn--danger"
                      onClick={() => removeAt(i)}
                      title="削除"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {steps.length > 0 && (
        <button type="button" className="arena-seq-clear" onClick={clearAll}>
          すべてクリア
        </button>
      )}
    </div>
  )
}
