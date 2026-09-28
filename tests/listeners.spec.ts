/**
 * Unit tests for the listener registration module.
 *
 * This is the project's highest-risk unit: two of the five listeners sit on
 * Cordis waterfalls that gate human approval, so the tests here are written as
 * guards against the destructive failure mode first and as behaviour coverage
 * second (docs/CONTRACT.md §4). Every test drives the handlers the module
 * actually registered: the fake `ctx` records what `ctx.on` received and hands
 * those handlers back, so a handler that is never registered fails the suite
 * rather than silently passing it.
 */

import { describe, expect, it, vi } from 'vitest'
import { registerListeners } from '../src/listeners.ts'
import type { Config } from '../src/config.ts'
import type { DshHookPayload, Forwarder } from '../src/types.ts'

/** One recorded `ctx.on` registration. */
interface Registration {
  event: string
  handler: (...args: never[]) => unknown
}

/** `ctx.on` as the module under test sees it, plus the call log. */
interface FakeContext {
  on: (event: string, handler: (...args: never[]) => unknown) => () => void
  /** Every registration, in registration order. */
  registrations: Registration[]
}

/** A recording forwarder plus the payloads it was handed. */
interface RecordedForwarder {
  forwarder: Forwarder
  sent: DshHookPayload[]
}

/** A root agent shaped like the projection the listeners read. */
function makeAgent(id: string, cwd = '/work/repo') {
  return { session: { header: { id, cwd } } }
}

/**
 * Build a fake context.
 *
 * `agents` is omitted entirely when `roots` is not supplied, which is how the
 * "service missing" case is exercised.
 */
function makeContext(options: { roots?: unknown[]; withAgents?: boolean } = {}): FakeContext & { ctx: unknown } {
  const registrations: Registration[] = []
  const ctx: Record<string, unknown> = {
    on(event: string, handler: (...args: never[]) => unknown) {
      registrations.push({ event, handler })
      return () => false
    },
  }
  // Present unless explicitly asked for a context without the service.
  if (options.withAgents !== false) {
    ctx['agents'] = { roots: () => options.roots ?? [] }
  }
  return { ctx, registrations } as FakeContext & { ctx: unknown }
}

/** Build a forwarder that records deliveries. */
function makeForwarder(): RecordedForwarder {
  const sent: DshHookPayload[] = []
  return {
    sent,
    forwarder: { forward: (payload) => { sent.push(payload) } },
  }
}

/** Resolve the single handler registered for one event, or fail loudly. */
function handlerFor(registrations: Registration[], event: string): (...args: never[]) => unknown {
  const matches = registrations.filter(r => r.event === event)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one registration for ${event}, found ${matches.length}`)
  }
  return matches[0]!.handler
}

/** Wire the module under test over the supplied fakes. */
function setup(options: {
  roots?: unknown[]
  withAgents?: boolean
  config?: Partial<Config>
  forwarder?: Forwarder
  isRoot?: (ctx: unknown, agent: unknown) => boolean
} = {}) {
  const fake = makeContext({ ...options.roots !== undefined ? { roots: options.roots } : {}, ...options.withAgents !== undefined ? { withAgents: options.withAgents } : {} })
  const recorded = options.forwarder === undefined ? makeForwarder() : undefined
  const forwarder = options.forwarder ?? recorded!.forwarder
  const sent = recorded?.sent ?? []

  const config: Config = {
    enabled: true,
    sessionStart: true,
    debug: false,
    ...options.config,
  }

  registerListeners(fake.ctx as never, {
    forwarder,
    config,
    ...options.isRoot !== undefined ? { isRoot: options.isRoot as never } : {},
  })

  return { registrations: fake.registrations, ctx: fake.ctx, forwarder, sent }
}

/** The five events this module must register, and nothing else. */
const EVENTS = [
  'agent/created',
  'approval/request',
  'user-questions/request',
  'agent/turn-stopping',
  'agent/error',
] as const

/** Trigger `agent/created`. */
function created(handler: (...args: never[]) => unknown, agent: unknown): unknown {
  return handler({ agent, source: 'startup', signal: new AbortController().signal } as never)
}

/** Trigger `agent/turn-stopping`. */
function turnStopping(handler: (...args: never[]) => unknown, agent: unknown): unknown {
  return handler({ agent, turn: 3, signal: new AbortController().signal } as never)
}

/** Trigger `agent/error`. */
function agentError(handler: (...args: never[]) => unknown, agent: unknown, error: unknown): unknown {
  return handler({ agent, turn: 1, step: 2, error } as never)
}

describe('registration', () => {
  it('registers exactly the five lifecycle events, in contract order', () => {
    const { registrations } = setup()
    expect(registrations.map(r => r.event)).toEqual([...EVENTS])
  })

  it('registers listeners even when forwarding is disabled', () => {
    const { registrations, sent } = setup({ config: { enabled: false } })
    expect(registrations).toHaveLength(5)
    expect(sent).toEqual([])
  })

  it('does not throw during registration when the agents service is absent', () => {
    expect(() => setup({ withAgents: false })).not.toThrow()
  })
})

describe('waterfall delegation: approval/request', () => {
  const root = makeAgent('root-1')

  it('calls next() exactly once and returns its result unchanged', async () => {
    const { registrations } = setup({ roots: [root] })
    const sentinel = { kind: 'approval-outcome' }
    const next = vi.fn(async () => sentinel)

    const returned = handlerFor(registrations, 'approval/request')(
      { agent: root, toolName: 'bash', reason: 'needs to write' } as never,
      next as never,
    )

    expect(next).toHaveBeenCalledTimes(1)
    // Object identity of BOTH the promise and its value: `next()`'s own
    // promise is handed straight back, not awaited, re-wrapped, or substituted.
    expect(returned).toBe(next.mock.results[0]!.value)
    expect(await returned).toBe(sentinel)
  })

  it('delegates even when the request carries no agent', async () => {
    const { registrations, sent } = setup({ roots: [root] })
    const sentinel = 'allowed-once'
    const next = vi.fn(async () => sentinel)

    const outcome = await handlerFor(registrations, 'approval/request')({} as never, next as never)

    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(sentinel)
    expect(sent).toEqual([])
  })

  it('forwards the approval as permission_required for a root agent', async () => {
    const { registrations, sent } = setup({ roots: [root] })

    await handlerFor(registrations, 'approval/request')(
      { agent: root, toolName: 'bash', reason: 'needs to write' } as never,
      (async () => 'allowed-once') as never,
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      hook_event_name: 'ApprovalRequest',
      session_id: 'root-1',
      cwd: '/work/repo',
      tool_name: 'bash',
      reason: 'needs to write',
    })
  })
})

describe('waterfall delegation: user-questions/request', () => {
  const root = makeAgent('root-1')

  it('calls next() exactly once and returns its result unchanged', async () => {
    const { registrations } = setup({ roots: [root] })
    const sentinel = { answers: [{ id: 'q1', selected: ['a'] }] }
    const next = vi.fn(async () => sentinel)

    const returned = handlerFor(registrations, 'user-questions/request')(
      { agent: root, questions: [{ id: 'q1', question: 'which?' }] } as never,
      next as never,
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(returned).toBe(next.mock.results[0]!.value)
    expect(await returned).toBe(sentinel)
  })

  it('forwards the first question as input_required for a root agent', async () => {
    const { registrations, sent } = setup({ roots: [root] })

    await handlerFor(registrations, 'user-questions/request')(
      { agent: root, questions: [{ id: 'q1', question: 'which?' }] } as never,
      (async () => ({ answers: [] })) as never,
    )

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      hook_event_name: 'UserQuestion',
      session_id: 'root-1',
      question: 'which?',
    })
  })
})

describe('delegation survives failure', () => {
  const root = makeAgent('root-1')
  const sentinel = { kind: 'answerer-result' }

  /**
   * The core guarantee: notification failure must not change the delegated
   * result, and delegation failure must not be converted into a delivered
   * notification or a swallowed error.
   */
  it.each(['approval/request', 'user-questions/request'] as const)(
    '%s: a throwing forwarder does not change the delegated result',
    async (event) => {
      const exploding: Forwarder = { forward: () => { throw new Error('spawn exploded') } }
      const { registrations } = setup({ roots: [root], forwarder: exploding })
      const next = vi.fn(async () => sentinel)

      const outcome = await handlerFor(registrations, event)({ agent: root, toolName: 'bash' } as never, next as never)

      expect(next).toHaveBeenCalledTimes(1)
      expect(outcome).toBe(sentinel)
    },
  )

  it.each(['approval/request', 'user-questions/request'] as const)(
    '%s: a throwing payload builder does not change the delegated result',
    async (event) => {
      // The agent projection throws on property access, which is what a real
      // revocation/teardown race looks like from inside a listener.
      const hostileAgent = {
        get session(): never {
          throw new Error('agent torn down')
        },
      }
      const { registrations } = setup({ roots: [hostileAgent] })
      const next = vi.fn(async () => sentinel)

      const outcome = await handlerFor(registrations, event)({ agent: hostileAgent } as never, next as never)

      expect(next).toHaveBeenCalledTimes(1)
      expect(outcome).toBe(sentinel)
    },
  )

  it.each(['approval/request', 'user-questions/request'] as const)(
    '%s: a rejected next() propagates unchanged',
    async (event) => {
      const { registrations } = setup({ roots: [root] })
      const failure = new Error('answerer chain failed')
      const next = vi.fn(async () => { throw failure })

      // The listener must hand back next()'s own promise: not a different
      // rejection, and not a resolved value.
      await expect(handlerFor(registrations, event)({ agent: root } as never, next as never)).rejects.toBe(failure)
      expect(next).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['approval/request', 'user-questions/request'] as const)(
    '%s: a synchronous throw from next() propagates unchanged',
    (event) => {
      const { registrations } = setup({ roots: [root] })
      const failure = new Error('waterfall closed')
      const next = vi.fn(() => { throw failure })

      // Returning the call (rather than awaiting it inside the try) is what
      // keeps this throw on the caller's stack instead of in our catch block.
      expect(() => handlerFor(registrations, event)({ agent: root } as never, next as never)).toThrow(failure)
      expect(next).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['approval/request', 'user-questions/request'] as const)(
    '%s: a throwing forwarder still forwards nothing and still delegates',
    async (event) => {
      let calls = 0
      const flaky: Forwarder = {
        forward: () => {
          calls += 1
          if (calls === 1) throw new Error('first delivery failed')
        },
      }
      const { registrations } = setup({ roots: [root], forwarder: flaky })

      await handlerFor(registrations, event)({ agent: root } as never, (async () => sentinel) as never)

      expect(calls).toBe(1)
    },
  )
})

describe('root-agent filtering', () => {
  const root = makeAgent('root-1')
  const child = makeAgent('sub-9')

  it('delivers agent/created for a root and drops a subagent', () => {
    const { registrations, sent } = setup({ roots: [root] })
    const handler = handlerFor(registrations, 'agent/created')

    created(handler, root)
    created(handler, child)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hook_event_name: 'SessionStart', session_id: 'root-1' })
  })

  it('delivers agent/turn-stopping for a root and drops a subagent', () => {
    const { registrations, sent } = setup({ roots: [root] })
    const handler = handlerFor(registrations, 'agent/turn-stopping')

    turnStopping(handler, root)
    turnStopping(handler, child)

    expect(sent.map(p => p.session_id)).toEqual(['root-1'])
  })

  it('delivers agent/error for a root and drops a subagent', () => {
    const { registrations, sent } = setup({ roots: [root] })
    const handler = handlerFor(registrations, 'agent/error')

    agentError(handler, root, new Error('root failed'))
    agentError(handler, child, new Error('child failed'))

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hook_event_name: 'RunFailed', session_id: 'root-1', error: 'root failed' })
  })

  it('does not deliver for any event when the roots list is empty', () => {
    const { registrations, sent } = setup({ roots: [] })

    created(handlerFor(registrations, 'agent/created'), root)
    turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)
    agentError(handlerFor(registrations, 'agent/error'), root, new Error('boom'))

    expect(sent).toEqual([])
  })

  it('treats a missing agents service as not-a-root instead of throwing', () => {
    const { registrations, sent } = setup({ withAgents: false })

    expect(() => created(handlerFor(registrations, 'agent/created'), root)).not.toThrow()
    expect(sent).toEqual([])
  })

  it('compares root identity, not structural equality', () => {
    const { registrations, sent } = setup({ roots: [root] })

    // Same ids, different object: the registry holds the instance, so a
    // look-alike must not be mistaken for the live root.
    created(handlerFor(registrations, 'agent/created'), makeAgent('root-1'))

    expect(sent).toEqual([])
  })

  it('uses an injected isRoot predicate in place of the registry', () => {
    const asked: unknown[] = []
    const { registrations, sent } = setup({
      roots: [], // registry knows nothing; the injected predicate decides.
      isRoot: (_ctx, agent) => {
        asked.push(agent)
        return true
      },
    })

    created(handlerFor(registrations, 'agent/created'), child)

    expect(asked).toEqual([child])
    expect(sent).toHaveLength(1)
  })

  it('drops a subagent on both waterfalls without skipping delegation', async () => {
    const { registrations, sent } = setup({ roots: [root] })
    const sentinel = { kind: 'answerer-result' }
    const next = vi.fn(async () => sentinel)

    const approval = await handlerFor(registrations, 'approval/request')(
      { agent: child, toolName: 'bash' } as never,
      next as never,
    )
    const question = await handlerFor(registrations, 'user-questions/request')(
      { agent: child, questions: [{ id: 'q1', question: 'which?' }] } as never,
      next as never,
    )

    expect(sent).toEqual([])
    expect(approval).toBe(sentinel)
    expect(question).toBe(sentinel)
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('listener bodies swallow their own failures', () => {
  const root = makeAgent('root-1')

  it('agent/created never throws, even when the forwarder explodes', () => {
    const exploding: Forwarder = { forward: () => { throw new Error('spawn exploded') } }
    const { registrations } = setup({ roots: [root], forwarder: exploding })

    expect(() => created(handlerFor(registrations, 'agent/created'), root)).not.toThrow()
  })

  it('agent/created never throws when the payload builder explodes', () => {
    const hostileAgent = { get session(): never { throw new Error('torn down') } }
    const { registrations } = setup({ roots: [hostileAgent] })

    expect(() => created(handlerFor(registrations, 'agent/created'), hostileAgent)).not.toThrow()
  })

  it('agent/created never throws on a malformed payload', () => {
    const { registrations } = setup({ roots: [root] })

    expect(() => handlerFor(registrations, 'agent/created')(undefined as never)).not.toThrow()
    expect(() => handlerFor(registrations, 'agent/created')({} as never)).not.toThrow()
    expect(() => handlerFor(registrations, 'agent/created')({ agent: null } as never)).not.toThrow()
  })

  it('agent/turn-stopping never throws, even when the forwarder explodes', () => {
    const exploding: Forwarder = { forward: () => { throw new Error('spawn exploded') } }
    const { registrations } = setup({ roots: [root], forwarder: exploding })

    expect(() => turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)).not.toThrow()
  })

  it('agent/turn-stopping never throws on a malformed payload', () => {
    const { registrations } = setup({ roots: [root] })
    const handler = handlerFor(registrations, 'agent/turn-stopping')

    expect(() => handler(undefined as never)).not.toThrow()
    expect(() => handler({} as never)).not.toThrow()
  })

  it('agent/error never throws, even when the forwarder explodes', () => {
    const exploding: Forwarder = { forward: () => { throw new Error('spawn exploded') } }
    const { registrations } = setup({ roots: [root], forwarder: exploding })

    expect(() => agentError(handlerFor(registrations, 'agent/error'), root, new Error('x'))).not.toThrow()
  })

  it('agent/error never throws on a malformed payload or a hostile error value', () => {
    const { registrations } = setup({ roots: [root] })
    const handler = handlerFor(registrations, 'agent/error')
    const hostile = { toString() { throw new Error('no repr') }, get message() { throw new Error('no message') } }

    expect(() => handler(undefined as never)).not.toThrow()
    expect(() => agentError(handler, root, hostile)).not.toThrow()
    expect(() => agentError(handler, root, undefined)).not.toThrow()
  })

  it('a throwing isRoot predicate never escapes a listener', async () => {
    const { registrations } = setup({
      roots: [root],
      isRoot: () => { throw new Error('predicate exploded') },
    })

    expect(() => created(handlerFor(registrations, 'agent/created'), root)).not.toThrow()
    expect(() => turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)).not.toThrow()
    expect(() => agentError(handlerFor(registrations, 'agent/error'), root, new Error('x'))).not.toThrow()
    await expect(
      handlerFor(registrations, 'approval/request')({ agent: root } as never, (async () => 'ok') as never),
    ).resolves.toBe('ok')
    await expect(
      handlerFor(registrations, 'user-questions/request')({ agent: root } as never, (async () => 'ok') as never),
    ).resolves.toBe('ok')
  })
})

describe('configuration switches', () => {
  const root = makeAgent('root-1')

  it('delivers nothing at all when enabled is false', async () => {
    const { registrations, sent } = setup({ roots: [root], config: { enabled: false } })

    created(handlerFor(registrations, 'agent/created'), root)
    turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)
    agentError(handlerFor(registrations, 'agent/error'), root, new Error('boom'))
    await handlerFor(registrations, 'approval/request')({ agent: root } as never, (async () => 'ok') as never)
    await handlerFor(registrations, 'user-questions/request')({ agent: root } as never, (async () => 'ok') as never)

    expect(sent).toEqual([])
  })

  it('still delegates both waterfalls when enabled is false', async () => {
    const { registrations } = setup({ roots: [root], config: { enabled: false } })
    const sentinel = { kind: 'answerer-result' }
    const next = vi.fn(async () => sentinel)

    const approval = await handlerFor(registrations, 'approval/request')({ agent: root } as never, next as never)
    const question = await handlerFor(registrations, 'user-questions/request')({ agent: root } as never, next as never)

    expect(approval).toBe(sentinel)
    expect(question).toBe(sentinel)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('suppresses only SessionStart when sessionStart is false', async () => {
    const { registrations, sent } = setup({ roots: [root], config: { sessionStart: false } })

    created(handlerFor(registrations, 'agent/created'), root)
    expect(sent).toEqual([])

    // Every other event is unaffected by this switch.
    turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)
    agentError(handlerFor(registrations, 'agent/error'), root, new Error('boom'))
    await handlerFor(registrations, 'approval/request')({ agent: root } as never, (async () => 'ok') as never)
    await handlerFor(registrations, 'user-questions/request')({ agent: root } as never, (async () => 'ok') as never)

    expect(sent.map(p => p.hook_event_name)).toEqual(['Stop', 'RunFailed', 'ApprovalRequest', 'UserQuestion'])
  })

  it('delivers when enabled and sessionStart are both defaulted on', () => {
    const { registrations, sent } = setup({ roots: [root] })

    created(handlerFor(registrations, 'agent/created'), root)
    turnStopping(handlerFor(registrations, 'agent/turn-stopping'), root)
    agentError(handlerFor(registrations, 'agent/error'), root, new Error('boom'))

    expect(sent.map(p => p.hook_event_name)).toEqual(['SessionStart', 'Stop', 'RunFailed'])
  })
})

describe('forwarded payloads', () => {
  const root = makeAgent('root-1')

  it('carries the session id and cwd from the agent projection', () => {
    // A non-default root: the payload must be projected from the event's agent,
    // not from anything cached at registration time.
    const other = makeAgent('root-2', '/other/dir')
    const { registrations, sent } = setup({ roots: [other] })

    created(handlerFor(registrations, 'agent/created'), other)

    expect(sent[0]).toMatchObject({ session_id: 'root-2', cwd: '/other/dir' })
  })

  it('normalizes an agent/error failure into a bounded string', () => {
    const { registrations, sent } = setup({ roots: [root] })

    agentError(handlerFor(registrations, 'agent/error'), root, new Error('boom'))
    agentError(handlerFor(registrations, 'agent/error'), root, 'plain string')

    expect(sent[0]?.error).toBe('boom')
    expect(sent[1]?.error).toBe('plain string')
  })
})
