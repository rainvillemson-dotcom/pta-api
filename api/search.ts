import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData } from '../lib/cache'

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
  notes:    ['Märkused', 'Tingimused', 'Erimärkused'],
}

function pick(row: Record<string, any>, keys: string[]): string {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k]
  return ''
}

function normalize(row: Record<string, any>) {
  return {
    nimetus:          pick(row, FIELD_MAP.name),
    toimeaine:        pick(row, FIELD_MAP.active),
    kultuur:          pick(row, FIELD_MAP.crop),
    kahjustaja:       pick(row, FIELD_MAP.pest),
    registreerimisnr: pick(row, FIELD_MAP.reg),
    liik:             pick(row, FIELD_MAP.type),
    annus:            pick(row, FIELD_MAP.dose),
    ooteaeg:          pick(row, FIELD_MAP.interval),
    loahoidja:        pick(row, FIELD_MAP.holder),
    kehtib_kuni:      pick(row, FIELD_MAP.valid_to),
    markused:         pick(row, FIELD_MAP.notes),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  try {
    const data = getData()
    const { q, kultuur, kahjustaja, toimeaine, liik, limit = '20' } = req.query
    const maxLimit = Math.min(parseInt(String(limit)) || 20, 50)
    let results = data.map(normalize)
    if (q) { const t = String(q).toLowerCase(); results = results.filter(r => r.nimetus.toLowerCase().includes(t) || r.toimeaine.toLowerCase().includes(t)) }
    if (kultuur) { const t = String(kultuur).toLowerCase(); results = results.filter(r => r.kultuur.toLowerCase().includes(t)) }
    if (kahjustaja) { const t = String(kahjustaja).toLowerCase(); results = results.filter(r => r.kahjustaja.toLowerCase().includes(t)) }
    if (toimeaine) { const t = String(toimeaine).toLowerCase(); results = results.filter(r => r.toimeaine.toLowerCase().includes(t)) }
    if (liik) { const t = String(liik).toLowerCase(); results = results.filter(r => r.liik.toLowerCase().includes(t)) }
    return res.status(200).json({ total: results.length, returned: Math.min(results.length, maxLimit), results: results.slice(0, maxLimit) })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
}
