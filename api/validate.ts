import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData, getToimeained } from '../lib/cache'

const FIELD_MAP = {
  name:     ['Taimekaitsevahendi nimi'],
  active:   ['Ohtlikud ained etiketil'],
  type:     ['Taimekaitsevahendi liik'],
  reg:      ['Registreerimise number'],
  holder:   ['Loa valdaja'],
  valid_to: ['Turulelaskmise loa lõpptähtaeg'],
  hazard:   ['Ohutuslaused hoiatuslaused'],
}

const KULTUUR_ALIASES: Record<string, string[]> = {
  nisu:    ['nisu','talinisu','suvinisu','durumnisu','speltanisu','teravil','teravili'],
  oder:    ['oder','talioder','suvioder','teravil','teravili'],
  raps:    ['raps','taliraps','suviraps','clearfield'],
  kartul:  ['kartul'],
  mais:    ['mais'],
  hernes:  ['hernes'],
  lina:    ['lina'],
  kaer:    ['kaer'],
  rukis:   ['rukis','talirukkil','talirukkis'],
}

function pick(row: Record<string, any>, keys: string[]): string {
  for (const k of keys) if (row[k] !== undefined && row[k] !== '') return row[k]
  return ''
}

function getAliases(kultuur: string): string[] {
  for (const [key, aliases] of Object.entries(KULTUUR_ALIASES)) {
    if (kultuur.includes(key) || key.includes(kultuur)) return aliases
  }
  return [kultuur]
}

function findKasutusala(row: Record<string, any>, aliases: string[]) {
  const kasutusalad = (row._kasutusalad || []) as any[]
  return kasutusalad.find((k: any) =>
    aliases.some(a => k.kultuur?.toLowerCase().includes(a))
  )
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
      const aliases = getAliases(searchCrop)

      const matches = data.filter(row => {
        const regName = pick(row, FIELD_MAP.name).toLowerCase()
        const searchWords = searchName.split(' ')
        return regName.includes(searchName) ||
          searchName.includes(regName) ||
          searchWords.every((w: string) => regName.includes(w))
      })

      if (!matches.length) return {
        nimetus: item.nimetus, kultuur: searchCrop, registris: false,
        sobiv_kultuurile: null, registreerimisnr: null, toimeaine: null,
        liik: null, annus: null, ooteaeg: null, kehtib_kuni: null, ksm: null,
        probleemid: ['Toodet ei leitud PTA registrist — kontrolli nimetust'],
      }

      const best = matches[0]
      const kasutusalaMatch = findKasutusala(best, aliases)
      const sobiv = !!kasutusalaMatch

      const validTo = pick(best, FIELD_MAP.valid_to)
      const probleemid: string[] = []
      if (!sobiv) {
        const olemasolevad = (best._kasutusalad || []).slice(0, 5).map((k: any) => k.kultuur).join(', ')
        probleemid.push(`Ei leitud luba kultuuril "${searchCrop}". Registreeritud kasutusalad: ${olemasolevad || '?'}`)
      }
      if (validTo && new Date(validTo) < new Date()) probleemid.push(`Luba aegunud: ${validTo}`)

      const piirangud = kasutusalaMatch?.piirangud || ''
      const bee_risk = /mesila|mesilane/i.test(piirangud)
      const water = /spe3|veekogu|veekaitsevöönd/i.test(piirangud)
      if (bee_risk) probleemid.push('Mesilaste oht — teavita mesinike 48h enne')
      if (water) probleemid.push('Veekaitsepiirangud — kontrolli SPe3')

      const taKey = pick(best, FIELD_MAP.active).toLowerCase().split(/[,;+]/)[0].trim()
      const ta = toimeained[taKey] ?? {}

      return {
        nimetus: item.nimetus, kultuur: searchCrop, registris: true,
        sobiv_kultuurile: sobiv,
        registreerimisnr: best['Taimekaitsevahendi ID'] || pick(best, FIELD_MAP.reg),
        toimeaine: (best._toimeained || []).join(', ') || pick(best, FIELD_MAP.active),
        liik: pick(best, FIELD_MAP.type),
        annus: kasutusalaMatch?.doos || null,
        ooteaeg: kasutusalaMatch?.ooteaeg || null,
        kordused: kasutusalaMatch?.kordused || null,
        kasutusala_info: (best._kasutusalad || [])
          .filter((k: any) => aliases.some(a => k.kultuur?.toLowerCase().includes(a)))
          .map((k: any) => ({
            kultuur: k.kultuur,
            kahjustaja: k.kahjustaja,
            doos: k.doos,
            ooteaeg: k.ooteaeg,
            kordused: k.kordused,
            koht: k.koht,
            piirangud: k.piirangud,
          })),
        koik_kasutusalad: (best._kasutusalad || []).map((k: any) => k.kultuur).filter(Boolean),
        kehtib_kuni: best['Turulelaskmise loa lõpptähtaeg'] || null,
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
