import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

async function main() {
  const outPath = path.join(DATA_DIR, 'toimeained.json')
  let existing = {}
  if (fs.existsSync(outPath)) existing = JSON.parse(fs.readFileSync(outPath, 'utf8')).data || {}

  // Get substances from pta-cache
  const cache = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'pta-cache.json'), 'utf8'))
  const substances = [...new Set(
    cache.rows.flatMap(r => (r['Ohtlikud ained etiketil'] || '').split(/[,;+]/).map(s => s.trim().toLowerCase()).filter(Boolean))
  )].sort()

  const toFetch = substances.filter(s => !existing[s]).slice(0, 40)
  console.log(`${substances.length} total, fetching ${toFetch.length} new from PPDB`)

  const result = { ...existing }
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
        result[name] = { nimetus: name, ppdb_id: match[1], bee_hazard: /bee.*high/i.test(h2) ? 'H' : 'L',
          groundwater_risk: gus !== null ? (gus > 2.8 ? 'H' : gus > 1.8 ? 'M' : 'L') : null,
          spe3: /spe3/i.test(h2), uuendatud: new Date().toISOString() }
        process.stdout.write(`✓\n`)
      } else {
        result[name] = { nimetus: name, uuendatud: new Date().toISOString() }
        process.stdout.write(`not found\n`)
      }
    } catch { result[name] = { nimetus: name, uuendatud: new Date().toISOString() }; process.stdout.write(`error\n`) }
    await new Promise(r => setTimeout(r, 600))
  }

  fs.writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString(), count: Object.keys(result).length, data: result }, null, 2))
  console.log(`Done. ${Object.keys(result).length} substances.`)
}

main().catch(e => { console.error(e); process.exit(1) })
