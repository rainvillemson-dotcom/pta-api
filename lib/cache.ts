import fs from 'fs'
import path from 'path'

const DATA_DIR = path.join(process.cwd(), 'data')

export function getData(): Record<string, any>[] {
  const file = path.join(DATA_DIR, 'pta-cache.json')
  if (!fs.existsSync(file)) return []
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return raw.rows ?? []
}

export function getToimeained(): Record<string, any> {
  const file = path.join(DATA_DIR, 'toimeained.json')
  if (!fs.existsSync(file)) return {}
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return raw.data ?? {}
}

export function getFields(data: Record<string, any>[]): string[] {
  if (!data.length) return []
  return Object.keys(data[0])
}
