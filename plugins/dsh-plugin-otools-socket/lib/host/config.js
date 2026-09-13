export const DEFAULT_PORT = 8790
export const LEDGER_FILE = 'ledger.json'

function boolean(value, fallback) {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const port = Number(raw.externalPort)
  const origins = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins.filter(value => typeof value === 'string' && /^https:\/\//i.test(value)).slice(0, 32)
    : []
  return {
    externalEnabled: boolean(raw.externalEnabled, false),
    externalHost: raw.externalHost === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
    externalPort: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
    allowedOrigins: origins,
  }
}
