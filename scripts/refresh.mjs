import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const URLS = {
  products:  'https://avaandmed.agri.ee/avaandmed/taimekaitse/Taimekaitsevahendid.csv',
  active:    'https://avaandmed.agri.ee/avaandmed/taimekaitse/Taimekaitsevahendid.toimeaine.csv',
  usage:     'https://avaandmed.agri.ee/avaandmed/taimekaitse/Taimekaitsevahendid.kasutusala.csv',
}

async function fetchCSV(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const text = await res.text()
  const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true })
  console.log(`  ${url.split('/').pop()}: ${parsed.data.length} rows, fields: ${parsed.meta.fields?.slice(0,5).join(', ')}...`)
  return parsed.data
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  console.log('Fetching PTA CSV files...')
  const [products, active, usage] = await Promise.all([
    fetchCSV(URLS.products),
    fetchCSV(URLS.active).catch(() => []),
    fetchCSV(URLS.usage),
  ])

  // Build usage map: productId -> [{kultuur, kahjustaja, doos, ooteaeg, piirangud, kordused}]
  const usageMap = {}
  for (const row of usage) {
    const id = row['Taimekaitsevahendi ID']
    if (!id) continue
    if (!usageMap[id]) usageMap[id] = []
    usageMap[id].push({
      kultuur:    row['Kasutusala'] ?? '',
      kahjustaja: row['Kahjustaja'] ?? '',
      doos:       `${row['Kulunorm 1'] ?? ''}${row['Kulunorm 2'] ? '-' + row['Kulunorm 2'] : ''} ${row['Ühik'] ?? ''}`.trim(),
      ooteaeg:    row['Ooteaeg'] ?? '',
      piirangud:  row['Piirangud'] ?? '',
      kordused:   row['Töötlemiskordi kasvuperioodil'] ?? '',
      intervall:  row['Töötlemiste intervall'] ?? '',
      koht:       row['Kasutamise koht'] ?? '',
    })
  }

  // Build active ingredients map: productId -> [toimeained]
  const activeMap = {}
  for (const row of active) {
    const id = row['Taimekaitsevahendi ID']
    if (!id) continue
    if (!activeMap[id]) activeMap[id] = []
    const ta = row['Toimeaine'] || row['Toimeaine nimi'] || Object.values(row)[1]
    if (ta) activeMap[id].push(ta)
  }

  // Merge into enriched products
  const enriched = products.map(p => {
    const id = p['Taimekaitsevahendi ID']
    return {
      ...p,
      _toimeained: activeMap[id] ?? [],
      _kasutusalad: usageMap[id] ?? [],
    }
  })

  fs.writeFileSync(
    path.join(DATA_DIR, 'pta-cache.json'),
    JSON.stringify({ updated: new Date().toISOString(), rows: enriched }, null, 2)
  )
  console.log(`Saved ${enriched.length} enriched products`)

  // Save usage separately for direct lookup
  fs.writeFileSync(
    path.join(DATA_DIR, 'kasutusalad.json'),
    JSON.stringify({ updated: new Date().toISOString(), rows: usage }, null, 2)
  )

  // Toimeained for PPDB enrichment
  const outPath = path.join(DATA_DIR, 'toimeained.json')
  let existing = {}
  if (fs.existsSync(outPath)) existing = JSON.parse(fs.readFileSync(outPath, 'utf8')).data || {}

  const substances = [...new Set(
    Object.values(activeMap).flat().map(s => s.trim().toLowerCase()).filter(Boolean)
  )].sort()
  console.log(`Found ${substances.length} unique active substances`)

  const result = { ...existing }
  const toFetch = substances.filter(s => !existing[s]).slice(0, 30)
  console.log(`Fetching PPDB for ${toFetch.length} new substances...`)

  for (const name of toFetch) {
    process.stdout.write(`  ${name}... `)
    try {
      const res = await fetch(
        `https://sitem.herts.ac.uk/aeru/ppdb/en/search.asp?SearchText=${encodeURIComponent(name)}&SearchType=1`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      )
      const html = await res.text()
      const match = html.match(/\/aeru\/ppdb\/en\/Reports\/(\d+)\.htm/)
      if (match) {
        const r2 = await fetch(`https://sitem.herts.ac.uk/aeru/ppdb/en/Reports/${match[1]}.htm`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
        const h2 = await r2.text()
        const gusM = h2.match(/GUS[^<]*<\/td>\s*<td[^>]*>([^<]+)/i)
        const gus = gusM ? parseFloat(gusM[1]) : null
        result[name] = {
          nimetus: name, ppdb_id: match[1],
          bee_hazard: /bee.*high/i.test(h2) ? 'H' : 'L',
          groundwater_risk: gus !== null ? (gus > 2.8 ? 'H' : gus > 1.8 ? 'M' : 'L') : null,
          spe3: /spe3/i.test(h2),
          uuendatud: new Date().toISOString()
        }
        process.stdout.write(`✓\n`)
      } else {
        result[name] = { nimetus: name, uuendatud: new Date().toISOString() }
        process.stdout.write(`not found\n`)
      }
    } catch { result[name] = { nimetus: name, uuendatud: new Date().toISOString() }; process.stdout.write(`error\n`) }
    await new Promise(r => setTimeout(r, 600))
  }

  fs.writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString(), count: Object.keys(result).length, data: result }, null, 2))
  console.log(`Done. ${Object.keys(result).length} substances saved.`)
}

main().catch(e => { console.error(e); process.exit(1) })
