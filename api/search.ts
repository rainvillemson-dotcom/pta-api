import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData, getUsageMap } from '../lib/cache'

const F = {
  name:     'Taimekaitsevahendi nimi',
  active:   'Ohtlikud ained etiketil',
  type:     'Taimekaitsevahendi liik',
  subtype:  'Taimekaitsevahendi alamliik',
  reg:      'Registreerimise number',
  holder:   'Loa valdaja',
  valid_to: 'Turulelaskmise loa lõpptähtaeg',
  hazard:   'Ohutuslaused hoiatuslaused',
  risk:     'Riskilaused ohulaused',
  form:     'Preparatiivne vorm',
  toimeaine_real: 'EL kombineeritud nomenklatuur',
}

function normalize(row: Record<string, any>) {
  return {
    nimetus:          row[F.name] ?? '',
    toimeaine:        row["EL kombineeritud nomenklatuur"] ?? "",
    toimeaine_real:   row['EL kombineeritud nomenklatuur'] ?? '',
    liik:             row[F.type] ?? '',
    alamliik:         row[F.subtype] ?? '',
    registreerimisnr: row['Registreerimise number'] ?? '',
    loahoidja:        row[F.holder] ?? '',
    kehtib_kuni:      row['Turulelaskmise loa lõpptähtaeg'] ?? '',
    ohutuslaused:     row[F.hazard] ?? '',
    riskilaused:      row[F.risk] ?? '',
    vorm:             row[F.form] ?? '',
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  try {
    const data = getData()
    const { q, liik, toimeaine, kultuur, kahjustaja, limit = '20' } = req.query
    const maxLimit = Math.min(parseInt(String(limit)) || 20, 50)
    let results = data.map(normalize)
    if (q) { const t = String(q).toLowerCase(); results = results.filter(r => r.nimetus.toLowerCase().includes(t) || r.toimeaine.toLowerCase().includes(t)) }
    if (kultuur) {
      const t = String(kultuur).toLowerCase()
      const usageMap = getUsageMap()
      results = results.filter(r => {
        const kasutusalad = usageMap[r.registreerimisnr] || []
        return kasutusalad.some((k: any) => k.kultuur?.toLowerCase().includes(t))
      })
    }
    if (kahjustaja) {
      const t = String(kahjustaja).toLowerCase()
      const usageMap = getUsageMap()
      results = results.filter(r => {
        const kasutusalad = usageMap[r.registreerimisnr] || []
        return kasutusalad.some((k: any) => k.kahjustaja?.toLowerCase().includes(t))
      })
    }
    if (liik) { const t = String(liik).toLowerCase(); results = results.filter(r => r.liik.toLowerCase().includes(t)) }
    if (toimeaine) { const t = String(toimeaine).toLowerCase(); results = results.filter(r => r.toimeaine.toLowerCase().includes(t)) }
    return res.status(200).json({ total: results.length, returned: Math.min(results.length, maxLimit), results: results.slice(0, maxLimit) })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
}
