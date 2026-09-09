import { networkInterfaces } from 'node:os'

export function lanCandidates(port) {
  const rows = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const row of entries ?? []) {
      if (row.family !== 'IPv4' || row.internal) continue
      rows.push(`http://${row.address}:${port}`)
    }
  }
  return [...new Set(rows)].sort()
}
