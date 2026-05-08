import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getData, getFields } from '../lib/cache'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end()
  try {
    const data = getData()
    const fields = getFields(data)
    return res.status(200).json({ total_rows: data.length, fields, sample_row: data[0] ?? {} })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
}
