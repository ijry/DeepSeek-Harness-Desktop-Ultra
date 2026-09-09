/** Optional attachment to the shared browser bus with delayed legacy fallback. */
export function openPanelChannel(ctx, options) {
  const clock = options.clock ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) }
  const graceMs = options.graceMs ?? 2500
  let disposed = false
  let generation = 0
  let ready = false
  let graceTimer
  let fallback
  let shared

  function closeFallback() {
    const stop = fallback
    fallback = undefined
    try { stop?.() } catch { /* gone */ }
  }

  function startFallback() {
    if (disposed || ready || fallback !== undefined) return
    fallback = options.startFallback?.() ?? (() => undefined)
  }

  graceTimer = clock.setTimeout(() => { graceTimer = undefined; startFallback() }, graceMs)

  const stopInject = ctx?.inject?.(['otoolsSocket'], serviceCtx => {
    const mine = ++generation
    shared = serviceCtx.otoolsSocket.subscribe(options.source, {
      onReady(snapshot) {
        if (disposed || mine !== generation) return
        ready = true
        closeFallback()
        options.onOpen?.(snapshot)
      },
      onEvent(name, data) {
        if (disposed || mine !== generation) return
        options.onFrame?.(name, data)
      },
      onUnavailable() {
        if (disposed || mine !== generation) return
        ready = false
        options.onClose?.()
        startFallback()
      },
    })
    return () => {
      if (mine !== generation) return
      generation += 1
      shared?.()
      shared = undefined
      ready = false
      if (!disposed) { options.onClose?.(); startFallback() }
    }
  })

  return () => {
    if (disposed) return
    disposed = true
    generation += 1
    if (graceTimer !== undefined) clock.clearTimeout(graceTimer)
    shared?.()
    stopInject?.()
    closeFallback()
  }
}
