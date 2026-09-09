import { createBrowserBusClient } from './bus-client.js'

export const name = 'dsh-plugin-otools-socket/client'
export const inject = []

export function apply(ctx) {
  const scheme = window.location.protocol === 'https:' ? 'wss://' : 'ws://'
  const client = createBrowserBusClient({ url: scheme + window.location.host + '/dsh-plugin-otools-socket/socket' })
  const remove = ctx.provide('otoolsSocket', client)
  const dispose = () => { remove?.(); client.dispose() }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'dsh-plugin-otools-socket: browser bus')
  else window.addEventListener('beforeunload', dispose, { once: true })
  return dispose
}
