// scripts/refresh.mjs
// Käivitub GitHub Actions-is kord ööpäevas
// 1. Laadib PTA CSV → ekstraktib unikaalsed toimeained
// 2. Rikastab PPDB-st (bee hazard, groundwater risk)
// 3. Salvestab data/toimeained.json ja data/pta-cache.json

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const PTA_CSV_URL = 'https://avaandmed.agri.ee/avaandmed/taimekaitse/Taimekaitsevahendid.csv'
const PPDB_BASE = 'https://sitem.herts.ac.uk/aeru/ppdb/en/Reports'

// ── 1. CSV helpers ──────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split('\n')
  if (lines.length < 2) return []
  const headerLine = lines[0].replace(/^\uFEFF/, '')
  const sep = headerLine.includes(';') ? ';' : ','
  const headers = headerLine.split(sep).map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(sep).map(v => v.trim().replace(/^"|"$/g, ''))
    const row = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}

function pickField(row, candidates) {
  for (const k of candidates) if (row[k] !== undefined && row[k] !== '') return row[k]
  return ''
}

// ── 2. PPDB scraper ──────────────────────────────────────────────────────────

// PPDB substance search — returns numeric ID for a substance name
async function ppdbSearch(name) {
  try {
    const url = `https://sitem.herts.ac.uk/aeru/ppdb/en/atoz.htm`
    // PPDB has a simple search via query param
    const res = await fetch(
      `https://sitem.herts.ac.uk/aeru/ppdb/en/search.asp?SearchText=${encodeURIComponent(name)}&SearchType=1`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
    )
    if (!res.ok) return null
    const html = await res.text()
    // Extract first result link e.g. /aeru/ppdb/en/Reports/123.htm
    const match = html.match(/\/aeru\/ppdb\/en\/Reports\/(\d+)\.htm/)
    return match ? match[1] : null
  } catch { return null }
}

// Scrape key KSM fields from PPDB substance page
async function ppdbScrape(id) {
  try {
    const res = await fetch(`${PPDB_BASE}/${id}.htm`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    })
    if (!res.ok) return {}
    const html = await res.text()

    const extract = (label) => {
      const re = new RegExp(`${label}[^<]*</td>\\s*<td[^>]*>([^<]+)`, 'i')
      const m = html.match(re)
      return m ? m[1].trim() : null
    }

    // Bee hazard: typically "High (II)" / "Medium" / "Low"
    const beeRaw = extract('Acute oral LD50 bee') || extract('bee LD50') || extract('Bee hazard')
    const bee_hazard = beeRaw
      ? (parseFloat(beeRaw) < 10 ? 'H' : parseFloat(beeRaw) < 100 ? 'M' : 'L')
      : null

    // GUS index > 2.8 = high groundwater risk
    const gusRaw = extract('GUS leaching potential')
    const gus = gusRaw ? parseFloat(gusRaw) : null
    const groundwater_risk = gus !== null
      ? (gus > 2.8 ? 'H' : gus > 1.8 ? 'M' : 'L')
      : null

    const dt50_soil = extract('DT50 soil') ? parseFloat(extract('DT50 soil')) : null
    const koc = extract('Koc') ? parseFloat(extract('Koc')) : null

    // SPe classification from label phrases
    const spe3 = /spe3/i.test(html)
    const spe8 = /spe8/i.test(html)

    return { bee_hazard, groundwater_risk, dt50_soil_days: dt50_soil, koc, spe3, spe8, ppdb_id: id }
  } catch { return {} }
}

// ── 3. EU Pesticides DB ──────────────────────────────────────────────────────

async function euPesticidesStatus(name) {
  try {
    const res = await fetch(
      `https://food.ec.europa.eu/plants/pesticides/eu-pesticides-database_en`,
      { signal: AbortSignal.timeout(8000) }
    )
    // EU DB doesn't have a clean REST API per substance — use known status from CSV notes
    // If PPDB lookup failed too, return unknown
    return { eu_staatus: 'unknown' }
  } catch {
    return { eu_staatus: 'unknown' }
  }
}

// ── 4. Main ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true })

  // --- Fetch PTA CSV ---
  console.log('Fetching PTA CSV...')
  let ptaRows = []
  try {
    const res = await fetch(PTA_CSV_URL, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    ptaRows = parseCSV(text)
    console.log(`  Loaded ${ptaRows.length} PTA rows`)

    // Save full PTA cache
    fs.writeFileSync(
      path.join(DATA_DIR, 'pta-cache.json'),
      JSON.stringify({ updated: new Date().toISOString(), rows: ptaRows }, null, 2)
    )
  } catch (e) {
    console.warn('PTA CSV fetch failed:', e.message)
    // Try to keep existing cache
    const existing = path.join(DATA_DIR, 'pta-cache.json')
    if (fs.existsSync(existing)) {
      ptaRows = JSON.parse(fs.readFileSync(existing, 'utf8')).rows
      console.log('  Using cached PTA data')
    }
  }

  // --- Extract unique active substances ---
  const ACTIVE_FIELDS = ['Toimeaine', 'toimeaine', 'Toimeained']
  const substanceSet = new Set()
  for (const row of ptaRows) {
    const raw = pickField(row, ACTIVE_FIELDS)
    if (!raw) continue
    // Split on common separators (comma, semicolon, "+")
    raw.split(/[,;+]/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(s => substanceSet.add(s))
  }
  const substances = [...substanceSet].sort()
  console.log(`Found ${substances.length} unique active substances`)

  // --- Load existing toimeained.json to avoid re-scraping ---
  const outPath = path.join(DATA_DIR, 'toimeained.json')
  let existing = {}
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8')).data || {}
  }

  // --- Enrich with PPDB (only new/missing substances) ---
  const result = { ...existing }
  const toFetch = substances.filter(s => !existing[s] || !existing[s].ppdb_id)
  console.log(`Fetching PPDB data for ${toFetch.length} new substances...`)

  for (const name of toFetch) {
    process.stdout.write(`  ${name}... `)
    const ppdbId = await ppdbSearch(name)
    let ppdbData = {}
    if (ppdbId) {
      ppdbData = await ppdbScrape(ppdbId)
      process.stdout.write(`PPDB ${ppdbId} ✓\n`)
    } else {
      process.stdout.write(`not found\n`)
    }

    result[name] = {
      nimetus: name,
      ...ppdbData,
      uuendatud: new Date().toISOString()
    }

    // Be polite to PPDB server
    await new Promise(r => setTimeout(r, 600))
  }

  // --- Save ---
  fs.writeFileSync(outPath, JSON.stringify({
    updated: new Date().toISOString(),
    count: Object.keys(result).length,
    data: result
  }, null, 2))

  console.log(`\nDone. Saved ${Object.keys(result).length} substances to data/toimeained.json`)
}

main().catch(e => { console.error(e); process.exit(1) })
