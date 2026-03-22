import { useState, useEffect, useMemo } from 'react'

const DDragon = 'https://ddragon.leagueoflegends.com'

const RESOURCE_LABEL = {
  spelldamage: 'AP',
  bonusattackdamage: 'ボーナスAD',
  attackdamage: 'AD',
  bonushealth: 'ボーナスHP',
  health: 'HP',
  mana: 'マナ',
  bonusmana: 'ボーナスマナ',
  armor: '防御力',
  bonusarmor: 'ボーナス防御力',
  spellblock: '魔法防御',
}

function renderTooltip(spell) {
  const varMap = {}
  spell.vars?.forEach(v => { varMap[v.key] = v })

  const resolved = spell.tooltip
    // {{ eN }} → effectBurn[N]
    .replace(/\{\{\s*e(\d+)\s*\}\}/g, (_, n) => spell.effectBurn[parseInt(n, 10)] ?? '?')
    // {{ aN }} / {{ fN }} → スケーリング係数
    .replace(/\{\{\s*([af]\d+)\s*\}\}/g, (_, key) => {
      const v = varMap[key]
      if (!v) return '?'
      const coeff = Array.isArray(v.coeff) ? v.coeff.join('/') : v.coeff
      const label = RESOURCE_LABEL[v.link] ?? v.link
      return `(+${coeff} ${label})`
    })
    // {{ varname }} → vars から名前で検索
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => {
      if (key === 'spellmodifierdescriptionappend') return ''
      const v = varMap[key]
      if (!v) return match  // 解決できない場合はそのまま残す
      const coeff = Array.isArray(v.coeff) ? v.coeff.join('/') : v.coeff
      const label = RESOURCE_LABEL[v.link] ?? v.link
      return `(+${coeff} ${label})`
    })
    // {{ varname*100 }} などの算術式 → 残す
    .replace(/<[^>]*>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  // 未解決の {{ ... }} が残っている場合は description にフォールバック
  if (/\{\{[^}]+\}\}/.test(resolved)) {
    return spell.description.replace(/<[^>]*>/g, '').trim()
  }
  return resolved
}

function patchNotesUrl(version) {
  if (!version) return null
  const [major, minor] = version.split('.')
  const actualMajor = parseInt(major, 10) + 10
  return `https://www.leagueoflegends.com/ja-jp/news/game-updates/league-of-legends-patch-${actualMajor}-${minor}-notes/`
}

export default function LoLInfo() {
  const [version, setVersion] = useState(null)
  const [champions, setChampions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState(null)
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const versions = await fetch(`${DDragon}/api/versions.json`).then(r => r.json())
        const v = versions[0]
        setVersion(v)
        const data = await fetch(`${DDragon}/cdn/${v}/data/ja_JP/champion.json`).then(r => r.json())
        const list = Object.values(data.data).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
        setChampions(list)
      } catch (e) {
        setError('データの取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    if (!selected || !version) return
    setDetailLoading(true)
    setDetail(null)
    fetch(`${DDragon}/cdn/${version}/data/ja_JP/champion/${selected.id}.json`)
      .then(r => r.json())
      .then(data => setDetail(data.data[selected.id]))
      .catch(() => setDetail(null))
      .finally(() => setDetailLoading(false))
  }, [selected, version])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return champions.filter(c => {
      if (activeTag && !c.tags.includes(activeTag)) return false
      if (!q) return true
      return c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
    })
  }, [champions, query, activeTag])

  function closeDetail() {
    setSelected(null)
    setDetail(null)
  }

  const tagColor = {
    Fighter: '#ef4444',
    Tank: '#3b82f6',
    Mage: '#8b5cf6',
    Assassin: '#f97316',
    Support: '#10b981',
    Marksman: '#f59e0b',
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">⚔️ LoL チャンピオン情報</h1>
        <p className="page-subtitle">Data Dragon v{version ?? '...'} — {champions.length} チャンピオン</p>
      </div>

      {version && (
        <div className="lol-patch-card">
          <div className="lol-patch-info">
            <span className="lol-patch-label">最新パッチ</span>
            <span className="lol-patch-version">Patch {parseInt(version.split('.')[0], 10) + 10}.{version.split('.')[1]}</span>
            <span className="lol-patch-sub">Data Dragon v{version}</span>
          </div>
          <a
            className="lol-patch-btn"
            href={patchNotesUrl(version)}
            target="_blank"
            rel="noopener noreferrer"
          >
            パッチノートを見る →
          </a>
        </div>
      )}

      <div className="lol-search-bar">
        <span className="lol-search-icon">🔍</span>
        <input
          className="lol-search-input"
          type="text"
          placeholder="チャンピオン名・キーワードで検索..."
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        {query && (
          <button className="lol-search-clear" onClick={() => setQuery('')}>✕</button>
        )}
      </div>

      {loading && (
        <div className="lol-loading">
          <div className="loading-spinner" />
          <p>チャンピオンデータを読み込み中...</p>
        </div>
      )}

      {error && (
        <div className="alert alert-error">{error}</div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="lol-empty">該当するチャンピオンが見つかりません</div>
      )}

      <div className="lol-role-filters">
        {[
          { tag: null,         label: 'すべて',    icon: '🏆' },
          { tag: 'Fighter',    label: 'ファイター', icon: '⚔️' },
          { tag: 'Tank',       label: 'タンク',     icon: '🛡️' },
          { tag: 'Mage',       label: 'メイジ',     icon: '🔮' },
          { tag: 'Assassin',   label: 'アサシン',   icon: '🗡️' },
          { tag: 'Support',    label: 'サポート',   icon: '💚' },
          { tag: 'Marksman',   label: 'マークスマン', icon: '🏹' },
        ].map(({ tag, label, icon }) => (
          <button
            key={tag ?? 'all'}
            className={`lol-role-btn${activeTag === tag ? ' active' : ''}`}
            style={activeTag === tag && tag ? { borderColor: tagColor[tag], color: tagColor[tag], background: `${tagColor[tag]}22` } : {}}
            onClick={() => setActiveTag(tag)}
          >
            <span>{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {!loading && !error && (
        <p className="lol-result-count">{filtered.length} 件表示</p>
      )}

      <div className="lol-grid">
        {filtered.map(champ => (
          <button
            key={champ.id}
            className="lol-champ-card"
            onClick={() => setSelected(champ)}
          >
            <img
              className="lol-champ-img"
              src={`${DDragon}/cdn/${version}/img/champion/${champ.id}.png`}
              alt={champ.name}
              loading="lazy"
            />
            <div className="lol-champ-name">{champ.name}</div>
            <div className="lol-champ-title">{champ.title}</div>
            <div className="lol-champ-tags">
              {champ.tags.map(tag => (
                <span
                  key={tag}
                  className="lol-tag"
                  style={{ background: `${tagColor[tag] ?? '#64748b'}22`, color: tagColor[tag] ?? '#94a3b8', borderColor: `${tagColor[tag] ?? '#64748b'}44` }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div className="lol-modal-overlay" onClick={closeDetail}>
          <div className="lol-modal" onClick={e => e.stopPropagation()}>
            <button className="lol-modal-close" onClick={closeDetail}>✕</button>

            {detailLoading && (
              <div className="lol-loading" style={{ minHeight: 200 }}>
                <div className="loading-spinner" />
              </div>
            )}

            {!detailLoading && detail && (
              <>
                <div className="lol-modal-header">
                  <img
                    className="lol-modal-splash"
                    src={`${DDragon}/cdn/img/champion/splash/${detail.id}_0.jpg`}
                    alt={detail.name}
                  />
                  <div className="lol-modal-title-block">
                    <h2 className="lol-modal-name">{detail.name}</h2>
                    <p className="lol-modal-title-text">{detail.title}</p>
                    <div className="lol-champ-tags" style={{ marginTop: 8 }}>
                      {detail.tags.map(tag => (
                        <span
                          key={tag}
                          className="lol-tag"
                          style={{ background: `${tagColor[tag] ?? '#64748b'}22`, color: tagColor[tag] ?? '#94a3b8', borderColor: `${tagColor[tag] ?? '#64748b'}44` }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <p className="lol-modal-lore">{detail.lore}</p>

                <div className="lol-stats-grid">
                  {[
                    { label: 'HP',     value: detail.stats.hp,                          growth: detail.stats.hpperlevel },
                    { label: 'HP再生', value: detail.stats.hpregen,                     growth: detail.stats.hpregenperlevel },
                    { label: 'MP',     value: detail.stats.mp,                          growth: detail.stats.mpperlevel },
                    { label: 'MP再生', value: detail.stats.mpregen,                     growth: detail.stats.mpregenperlevel },
                    { label: '攻撃力', value: detail.stats.attackdamage,                growth: detail.stats.attackdamageperlevel },
                    { label: '攻撃速度', value: detail.stats.attackspeed?.toFixed(3),   growth: detail.stats.attackspeedperlevel, unit: '%' },
                    { label: '防御力', value: detail.stats.armor,                       growth: detail.stats.armorperlevel },
                    { label: '魔法防御', value: detail.stats.spellblock,                growth: detail.stats.spellblockperlevel },
                    { label: '移動速度', value: detail.stats.movespeed },
                    { label: '射程',   value: detail.stats.attackrange },
                  ].map(s => (
                    <div key={s.label} className="lol-stat-item">
                      <span className="lol-stat-label">{s.label}</span>
                      <span className="lol-stat-value">
                        {s.value}
                        {s.growth > 0 && (
                          <span className="lol-stat-growth">+{s.growth}{s.unit ?? ''}/lv</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                <h3 className="lol-section-title">スキル</h3>
                <div className="lol-spells">
                  <div className="lol-spell">
                    <img
                      className="lol-spell-img"
                      src={`${DDragon}/cdn/${version}/img/passive/${detail.passive.image.full}`}
                      alt={detail.passive.name}
                    />
                    <div className="lol-spell-info">
                      <span className="lol-spell-key">パッシブ</span>
                      <span className="lol-spell-name">{detail.passive.name}</span>
                      <p className="lol-spell-desc">{detail.passive.description.replace(/<[^>]*>/g, '')}</p>
                    </div>
                  </div>
                  {detail.spells.map((spell, i) => (
                    <div key={spell.id} className="lol-spell">
                      <img
                        className="lol-spell-img"
                        src={`${DDragon}/cdn/${version}/img/spell/${spell.image.full}`}
                        alt={spell.name}
                      />
                      <div className="lol-spell-info">
                        <div className="lol-spell-header">
                          <span className="lol-spell-key">{['Q', 'W', 'E', 'R'][i]}</span>
                          <span className="lol-spell-name">{spell.name}</span>
                        </div>
                        <div className="lol-spell-meta">
                          <span className="lol-spell-meta-item lol-spell-cd" title="クールダウン">
                            ⏱ {spell.cooldownBurn}s
                          </span>
                          {spell.costBurn !== '0' && (
                            <span className="lol-spell-meta-item lol-spell-cost">
                              💧 {spell.costBurn} {spell.costType.replace(/\{\{\s*abilityresourcename\s*\}\}/gi, detail.partype)}
                            </span>
                          )}
                        </div>
                        <p className="lol-spell-desc">{renderTooltip(spell)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
