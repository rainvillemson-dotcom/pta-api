import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Papa from 'papaparse'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const PTA_CSV_URL = 'https://avaandmed.agri.ee/avaandmed/taimekaitse/Taimekaitsevahendid.csv'

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  console.log('Fetching PTA CSV...')
  let rows = []
  try {
    const res = await fetch(PTA_CSV_URL, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const parsed = Papa.parse(text.replace(/^\uFEFF/, ''), {
      header: true,
      skipEmptyLines: true,
      delimiter: ',',
    })
    rows = parsed.data
    console.log(`Loaded ${rows.length} rows, fields: ${parsed.meta.fields?.join(', ')}`)
    fs.writeFileSync(
      path.join(DATA_DIR, 'pta-cache.json'),
      JSON.stringify({ updated: new Date().toISOString(), rows }, null, 2)
    )
  } catch (e) {
    console.warn('PTA CSV fetch failed:', e.message)
  }

  // Load existing toimeained
  const outPath = path.join(DATA_DIR, 'toimeained.json')
  let existing = {}
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8')).data || {}
  }

  // Extract unique active substances
  const substances = [...new Set(
    rows.flatMap(r => (r['Ohtlikud ained etiketil'] || '')
      .split(/[,;+]/).map(s => s.trim().toLowerCase()).filter(Boolean))
  )].sort()
  console.log(`Found ${substances.length} unique substances`)

  const result = { ...existing }
  const toFetch = substances.filter(s => !existing[s])
  console.log(`Fetching PPDB for ${toFetch.length} new substances...`)

  for (const name of toFetch.slice(0, 50)) { // max 50 per run
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
          nimetus: name,
          ppdb_id: match[1],
          bee_hazard: /bee.*high|LD50.*bee.*[0-9]/.test(h2) ? 'H' : 'L',
          groundwater_risk: gus !== null ? (gus > 2.8 ? 'H' : gus > 1.8 ? 'M' : 'L') : null,
          spe3: /spe3/i.test(h2),
          uuendatud: new Date().toISOString()
        }
        process.stdout.write(`✓\n`)
      } else {
        result[name] = { nimetus: name, uuendatud: new Date().toISOString() }
        process.stdout.write(`not found\n`)
      }
    } catch {
      result[name] = { nimetus: name, uuendatud: new Date().toISOString() }
      process.stdout.write(`error\n`)
    }
    await new Promise(r => setTimeout(r, 600))
  }

  fs.writeFileSync(outPath, JSON.stringify({
    updated: new Date().toISOString(),
    count: Object.keys(result).length,
    data: result
  }, null, 2))

  console.log(`Done. ${Object.keys(result).length} substances saved.`)
}

main().catch(e => { console.error(e); process.exit(1) })
