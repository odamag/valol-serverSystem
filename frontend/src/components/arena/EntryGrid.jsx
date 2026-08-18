import { useState, useMemo } from 'react'

// BAN/PICK対象のエントリー選択グリッド。検索付き。
// entries: [{id, slug, name, image_url, tags}]
// unavailableIds: Set<number>（BAN済み・選択済みで選べないID）
// onSelect: (entryId) => void
export default function EntryGrid({ entries, unavailableIds, onSelect, disabled, entryLabel }) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return entries
    return entries.filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.slug.toLowerCase().includes(q) ||
      (e.tags || '').toLowerCase().includes(q)
    )
  }, [entries, query])

  const label = entryLabel || 'エントリー'

  return (
    <div className="arena-entry-grid-wrap">
      <input
        className="form-input arena-entry-grid-search"
        placeholder={`${label}を検索`}
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="arena-empty">該当する{label}がありません</p>
      ) : (
        <div className="arena-entry-grid">
          {filtered.map(entry => {
            const isUnavailable = unavailableIds.has(entry.id)
            return (
              <button
                key={entry.id}
                type="button"
                className={`arena-entry-cell${isUnavailable ? ' arena-entry-cell--unavailable' : ''}`}
                disabled={disabled || isUnavailable}
                onClick={() => onSelect(entry.id)}
                title={entry.name}
              >
                {entry.image_url
                  ? <img className="arena-entry-cell-img" src={entry.image_url} alt="" />
                  : <span className="arena-entry-cell-placeholder">{entry.name.slice(0, 1)}</span>}
                <span className="arena-entry-cell-name">{entry.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
