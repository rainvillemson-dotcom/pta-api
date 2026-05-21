import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData, getToimeained, getUsageMap } from '../lib/cache'

const FIELD_MAP = {
  name:     ['Taimekaitsevahendi nimi'],
  active:   ['EL kombineeritud nomenklatuur'],
  type:     ['Taimekaitsevahendi liik'],
  reg:      ['Taimekaitsevahendi ID'],
}

const KULTUUR_ALIASES: Record<string, string[]> = {
  nisu:    ['nisu','talinisu','suvinisu','durumnisu','speltanisu','teravili','teravil'],
  oder:    ['oder','talioder','suvioder','teravili','teravil'],
  raps:    ['raps','taliraps','suviraps','clearfield'],
  kartul:  ['kartul'],
  mais:    ['mais'],
  hernes:  ['hernes'],
  lina:    ['lina'],
  kaer:    ['kaer'],
  rukis:   ['rukis'],
}

function pick(row: Record<string, any>, keys: string[]): string {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return String(row[k])
  return ''
}

function getAliases(kultuur: string): string[] {
  for (const [key, aliases] of Object.entries(KULTUUR_ALIASES)) {
    if (kultuur.includes(key) || key.includes(kultuur)) return aliases
  }
  return [kultuur]
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
    const usageMap = getUsageMap()

    const results = tooted.map(item => {
      const searchName = item.nimetus.toLowerCase().trim()
      const searchCrop = (item.kultuur || kultuur).toLowerCase().trim()
      const aliases = getAliases(searchCrop)

      const matches = data.filter(row => {
        const regName = pick(row, FIELD_MAP.name).toLowerCase()
        if (!regName) return false
        const words = searchName.split(' ')
        return regName.includes(searchName) || words.every(w => regName.includes(w))
      })

      if (!matches.length) return {
        nimetus: item.nimetus, kultuur: searchCrop, registris: false,
        sobiv_kultuurile: null, registreerimisnr: null, toimeaine: null,
        liik: null, annus: null, ooteaeg: null, kehtib_kuni: null, ksm: null,
        probleemid: ['Toodet ei leitud PTA registrist — kontrolli nimetust'],
      }

      const best = matches[0]
      const id = pick(best, FIELD_MAP.reg)
      const kasutusalad = usageMap[id] || []

      const kasutusalaMatch = kasutusalad.find((k: any) =>
        aliases.some(a => k.kultuur?.toLowerCase().includes(a))
      )
      const sobiv = !!kasutusalaMatch

      const probleemid: string[] = []
      if (!sobiv) {
        const olemasolevad = kasutusalad.slice(0, 5).map((k: any) => k.kultuur).join(', ')
        probleemid.push(`Ei leitud luba kultuuril "${searchCrop}". Registreeritud: ${olemasolevad || '?'}`)
      }

      const piirangud = kasutusalaMatch?.piirangud || ''
      const bee_risk = /mesila|mesilane/i.test(piirangud)
      const water = /spe3|veekogu|veekaitsevöönd|puhvertsoon/i.test(piirangud)
      if (bee_risk) probleemid.push('Mesilaste oht — teavita mesinike 48h enne')
      if (water) probleemid.push('Veekaitsepiirangud — kontrolli SPe3')

      const taKey = pick(best, FIELD_MAP.active).toLowerCase().split(/[,;+]/)[0].trim()
      const ta = toimeained[taKey] ?? {}

      const nisulKasutusalad = kasutusalad.filter((k: any) =>
        aliases.some(a => k.kultuur?.toLowerCase().includes(a))
      )

      return {
        nimetus: item.nimetus,
        kultuur: searchCrop,
        registris: true,
        sobiv_kultuurile: sobiv,
        registreerimisnr: id,
        toimeaine: (best._toimeained || []).join(', ') || pick(best, FIELD_MAP.active),
        liik: pick(best, FIELD_MAP.type),
        annus: kasutusalaMatch?.doos || null,
        ooteaeg: kasutusalaMatch?.ooteaeg || null,
        kordused: kasutusalaMatch?.kordused || null,
        kehtib_kuni: best["Turulelaskmise loa lõpptähtaeg"] || null,
        kasutusala_info: nisulKasutusalad.slice(0, 5),
        koik_kasutusalad: [...new Set(kasutusalad.map((k: any) => k.kultuur).filter(Boolean))].slice(0, 10),
        ksm: {
          spe3_piirangud: piirangud || null,
          mesilaste_oht: bee_risk || ta.bee_hazard === 'H',
          groundwater_risk: ta.groundwater_risk ?? null,
          veekaitse: water || ta.spe3 === true,
          markused: piirangud || null,
        },
        probleemid: probleemid.length ? probleemid : null,
      }
    })

    return res.status(200).json({
      kultuur,
      kokkuvote: {
        tooted_kokku: results.length,
        sobivad: results.filter(r => r.sobiv_kultuurile).length,
        probleemiga: results.filter(r => r.probleemid?.length).length,
      },
      tulemused: results,
    })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
}
