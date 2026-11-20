/**
 * dsh-auto-idle-compact
 *
 * Watches user-facing agents. Once an agent has been idle for the configured time,
 * it checks whether the session's measured context is at least the configured token
 * threshold. If so, it invokes the mounted DSH compaction engine (`compactNow`) on
 * the live idle agent. No summary is produced when the session is busy, the last
 * turn did not finish normally, background jobs/subagents are still running, or the
 * context is below the threshold.
 *
 * The plugin intentionally compacts at most once per finished turn.
 */

export const name = 'dsh-auto-idle-compact'

// `ctx.timeout()` is a mixin of the timer service, so the service must be injected.
export const inject = ['timer']

const DEFAULTS = Object.freeze({
  idleSeconds: 20 * 60,
  contextThresholdTokens: 128 * 1024,
})

const AGENT = Object.freeze({
  statusIdle: 'idle',
  subagentOrigin: 'subagent',
})

const SESSION_EVENT = Object.freeze({
  turnEnd: 'turn/end',
  turnCompleted: 'completed',
})

const BACKGROUND_ACTIVITY_KINDS = Object.freeze(['job', 'subagent'])

function liveNumber(value, fallback) {
  const resolved = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
  return typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : fallback
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function lastTurnEnd(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === SESSION_EVENT.turnEnd) return { event, seq }
  }
  return undefined
}

function lastTurnCompleted(session) {
  return lastTurnEnd(session)?.event.data?.reason?.kind === SESSION_EVENT.turnCompleted
}

function serviceFor(ctx, agent, key) {
  return agent.ctx?.get?.(key)
    ?? ctx.get('agentPresets')?.serviceFor?.(agent, key)
    ?? ctx.get(key)
}

async function hasBackgroundWork(ctx, session) {
  const families = await ctx.waterfall(
    'workspace/session-activity',
    { sessionId: session.id },
    () => Promise.resolve([]),
  )
  return families.some(family =>
    BACKGROUND_ACTIVITY_KINDS.includes(family.kind) && family.items.length > 0,
  )
}

function isArchived(ctx, session) {
  return ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(session.id) ?? false
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger(name)
  const timers = new Map()
  const running = new Map()
  // session id -> seq of the turn/end for which we already tried compaction
  const attempted = new Map()

  const idleMs = () => Math.max(1, liveNumber(config.idleSeconds, DEFAULTS.idleSeconds)) * 1000
  const threshold = () => Math.max(1, liveNumber(
    config.contextThresholdTokens,
    DEFAULTS.contextThresholdTokens,
  ))

  const disarm = (agent) => {
    const dispose = timers.get(agent)
    if (dispose !== undefined) {
      timers.delete(agent)
      dispose()
    }
    const controller = running.get(agent)
    if (controller !== undefined) {
      running.delete(agent)
      controller.abort()
    }
  }

  const arm = (agent, elapsedMs = 0) => {
    disarm(agent)
    if (agent.status !== AGENT.statusIdle) return
    if (agent.session?.header?.origin === AGENT.subagentOrigin) return
    if (isArchived(ctx, agent.session)) return

    const end = lastTurnEnd(agent.session)
    if (end === undefined || !lastTurnCompleted(agent.session)) return
    if (attempted.get(agent.session.id) === end.seq) return

    const remainingMs = Math.max(0, idleMs() - elapsedMs)
    timers.set(agent, ctx.timeout(() => {
      void fire(agent)
    }, remainingMs))
  }

  const fire = async (agent) => {
    timers.delete(agent)
    if (running.has(agent)) return
    if (agent.status !== AGENT.statusIdle) return

    const session = agent.session
    if (isArchived(ctx, session)) {
      logger.info('session %s: skipped because it is archived', agent.id)
      return
    }
    const end = lastTurnEnd(session)
    if (end === undefined || !lastTurnCompleted(session)) return
    if (attempted.get(session.id) === end.seq) return

    const meter = serviceFor(ctx, agent, 'tokenMeter')
    const compaction = serviceFor(ctx, agent, 'compaction')
    if (meter === undefined || compaction === undefined) {
      logger.warn('session %s: compaction services are unavailable', agent.id)
      return
    }

    // Mark this finished turn before the async checks so concurrent idle events do
    // not schedule another attempt for the same turn.
    attempted.set(session.id, end.seq)

    let controller
    try {
      if (await hasBackgroundWork(ctx, session)) {
        logger.info('session %s: skipped because background work is running', agent.id)
        return
      }
      if (agent.status !== AGENT.statusIdle) return

      const tokens = meter.measure(session).totalTokens
      if (tokens <= threshold()) {
        logger.info('session %s: skipped at %d tokens (not over %d)', agent.id, tokens, threshold())
        return
      }

      controller = new AbortController()
      running.set(agent, controller)
      logger.info(
        'session %s idle for %ds with %d tokens; compacting',
        agent.id,
        Math.floor(idleMs() / 1000),
        tokens,
      )
      const result = await compaction.compactNow(agent, controller.signal)
      if (result === null) {
        logger.info('session %s: nothing safe to compact', agent.id)
      } else {
        logger.info(
          'session %s: compacted %d history items, released about %d tokens',
          agent.id,
          result.shadowedSeqs?.length ?? 0,
          result.shadowedTokenCount ?? 0,
        )
      }
    } catch (error) {
      // A new user/agent activity aborts the idle controller; that is not a failure.
      if (controller !== undefined && !controller.signal.aborted) {
        logger.warn('session %s: automatic idle compaction failed: %s', agent.id, errorText(error))
      }
    } finally {
      if (controller !== undefined && running.get(agent) === controller) running.delete(agent)
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === AGENT.statusIdle) arm(agent)
    else disarm(agent)
  })

  ctx.on('agent/created', ({ agent }) => {
    if (agent.status === AGENT.statusIdle) arm(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    disarm(agent)
    attempted.delete(agent.session?.id)
  })

  // Archiving may happen while the idle timer is pending. Stop that timer (and
  // any in-flight compaction started for the session) immediately.
  ctx.on('workspace/session-archived', ({ sessionId }) => {
    for (const agent of new Set([...timers.keys(), ...running.keys()])) {
      if (agent.session?.id === sessionId) disarm(agent)
    }
  })

  // Cover sessions that are already idle when this plugin is loaded or DSH restarts.
  for (const agent of ctx.get('agents')?.list() ?? []) {
    if (agent.status !== AGENT.statusIdle) continue
    const end = lastTurnEnd(agent.session)
    if (end === undefined) continue
    const elapsedMs = Math.max(0, Date.now() - (end.event.time ?? Date.now()))
    arm(agent, elapsedMs)
  }

  ctx.effect(() => () => {
    for (const agent of new Set([...timers.keys(), ...running.keys()])) disarm(agent)
    timers.clear()
    running.clear()
    attempted.clear()
  }, 'auto-idle-compact: lifecycle')
}
