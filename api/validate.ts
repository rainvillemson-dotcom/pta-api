import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData, getToimeained } from '../lib/cache'

const FIELD_MAP = {
  name:     ['Nimetus', 'nimetus', 'Toote nimetus', 'Preparaat'],
  active:   ['Toimeaine', 'toimeaine', 'Toimeained'],
  crop:     ['Kultuur', 'kultuur', 'Kultuurid'],
  pest:     ['Kahjustaja', 'kahjustaja', 'Kahjustajad', 'Objekt'],
  reg:      ['Registreerimisnumber', 'Reg nr', 'RegNr'],
  type:     ['Liik', 'Vahendi liik', 'Preparaadi liik'],
  dose:     ['Annus', 'Doos', 'Kasutusannus'],
  interval: ['Ooteaeg', 'Ooteaeg (päeva)', 'PHI'],
  holder:   ['Loa hoidja', 'Loahoidja', 'Firma'],
  valid_to: ['Kehtivuse lõpp', 'Loa lõpp', 'Kehtib kuni'],
  notes:    ['Märkused', 'Tingimused', 'Erimärkused', 'SPe'],
}

function pick(row: Record<string, any>, keys: string[]): string {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k]
  return ''
}

function parseKSM(notes: string) {
  const t = notes.toLowerCase()
  const spe3Match = t.match(/spe3[^.;,\n]{0,80}/)
  return {
    spe3: spe3Match ? spe3Match[0].trim() : null,
    bee_risk: /mesila|mesilane|bee|tolmleja/i.test(t),
    max_applications: (t.match(/max[^\d]*(\d+)\s*kord|(\d+)\s*kord[^\d]{0,20}hooaj/) || [null,null,null]).slice(1).find(Boolean) ? `${(t.match(/max[^\d]*(\d+)\s*kord|(\d+)\s*kord[^\d]{0,20}hooaj/) || [])[1] || (t.match(/max[^\d]*(\d+)\s*kord|(\d+)\s*kord[^\d]{0,20}hooaj/) || [])[2]} korda hooajal` : null,
    water_protection: /spe3|veekogu|veekaitsevöönd|põhjavesi/i.test(t),
    raw_notes: notes,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  let body: { kultuur: string; tooted: { nimetus: string; kultuur?: string }[] }
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body }
  catch { return res.status(400).json({ error: 'Invalid JSON' }) }
  const { kultuur, tooted } = body
  if (!kultuur || !Array.isArray(tooted) || !tooted.length)
    return res.status(400).json({ error: 'Required: kultuur and tooted[]' })
  try {
    const data = getData()
    const toimeained = getToimeained()
    const results = tooted.map(item => {
      const searchName = item.nimetus.toLowerCase().trim()
      const searchCrop = (item.kultuur || kultuur).toLowerCase().trim()
      const matches = data.filter(row => {
        const n = pick(row, FIELD_MAP.name).toLowerCase()
        return n.includes(searchName) || searchName.includes(n.split(' ')[0])
      })
      if (!matches.length) return {
        nimetus: item.nimetus, kultuur: searchCrop, registris: false,
        sobiv_kultuurile: null, registreerimisnr: null, toimeaine: null,
        liik: null, annus: null, ooteaeg: null, kehtib_kuni: null, ksm: null,
        probleemid: ['Toodet ei leitud PTA registrist — kontrolli nimetust'],
      }
      const cropMatch = matches.find(row => pick(row, FIELD_MAP.crop).toLowerCase().includes(searchCrop))
      const best = cropMatch || matches[0]
      const notes = pick(best, FIELD_MAP.notes)
      const ksm = parseKSM(notes)
      const validTo = pick(best, FIELD_MAP.valid_to)
      const probleemid: string[] = []
      if (!cropMatch) probleemid.push(`Ei leitud luba kultuuril "${searchCrop}" — registris: ${pick(best, FIELD_MAP.crop) || '?'}`)
      if (validTo) {
        const exp = new Date(validTo.split('.').reverse().join('-'))
        if (!isNaN(exp.getTime()) && exp < new Date()) probleemid.push(`Luba aegunud: ${validTo}`)
      }
      if (ksm.bee_risk) probleemid.push('Mesilaste oht — teavita mesinike 48h enne')
      if (ksm.water_protection) probleemid.push('Veekaitsepiirangud — kontrolli SPe3')
      const taKey = pick(best, FIELD_MAP.active).toLowerCase().split(/[,;+]/)[0].trim()
      const ta = toimeained[taKey] ?? {}
      return {
        nimetus: item.nimetus, kultuur: searchCrop, registris: true,
        sobiv_kultuurile: !!cropMatch,
        registreerimisnr: pick(best, FIELD_MAP.reg),
        toimeaine: pick(best, FIELD_MAP.active),
        liik: pick(best, FIELD_MAP.type),
        annus: pick(best, FIELD_MAP.dose),
        ooteaeg: pick(best, FIELD_MAP.interval),
        kehtib_kuni: validTo || null,
        ksm: {
          spe3_puhvertsoon: ksm.spe3,
          mesilaste_oht: ksm.bee_risk || ta.bee_hazard === 'H',
          bee_hazard_klass: ta.bee_hazard ?? null,
          groundwater_risk: ta.groundwater_risk ?? null,
          max_kordused: ksm.max_applications,
          veekaitse: ksm.water_protection || ta.spe3 === true,
          dt50_soil_days: ta.dt50_soil_days ?? null,
          markused: notes || null,
        },
        probleemid: probleemid.length ? probleemid : null,
      }
    })
    return res.status(200).json({
      kultuur,
      kokkuvote: { tooted_kokku: results.length, sobivad: results.filter(r => r.sobiv_kultuurile).length, probleemiga: results.filter(r => r.probleemid?.length).length },
      tulemused: results,
    })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
}
