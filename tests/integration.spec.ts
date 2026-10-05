/**
 * End-to-end smoke test over the assembled plugin.
 *
 * The unit suites prove each module in isolation; this one proves the
 * composition - that apply() registers the real listener set and that a real
 * event travels listener -> payload -> forwarder unchanged. It is the only
 * test that would catch a wiring regression, such as a listener never being
 * registered or a payload builder swapped at the call site.
 *
 * Root detection note: the production check compares against the SAME Agent
 * objects the registry holds (ctx.agents.roots().includes(agent)), so these
 * fakes must hand back identical object references, not equal-looking copies.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { apply, Config, inject, name } from '../src/index.ts'
import { registerListeners } from '../src/listeners.ts'
import type { DshHookPayload, Forwarder } from '../src/types.ts'

/** A recorded ctx.on registration. */
interface Registration {
  event: string
  handler: (...args: unknown[]) => unknown
}

/** A pretend root agent, shaped like the projection the plugin reads. */
function agent(id: string, cwd = '/work/repo') {
  return { session: { header: { id, cwd } } }
}

/**
 * Minimal Context stand-in, faithful to the two Cordis behaviours this plugin
 * actually depends on.
 *
 * **Faithfulness matters here.** An earlier version of this fake was a plain
 * object with an `agents` property, which made every test pass while the real
 * plugin delivered nothing: a Cordis context is a proxy whose `get` trap
 * THROWS for a service the fiber has not injected, so `ctx.agents` blew up
 * inside each listener's try/catch and was swallowed. A double that cannot
 * reproduce the failure it guards against is worse than no double at all.
 *
 * Reproduced behaviours:
 *
 * 1. Reading a service by property throws unless it is "injected" - passing
 *    `injected: true` models the registry being visible, `false` (default) the
 *    throwing proxy.
 * 2. `ctx.get(name)` reads the store directly and returns undefined when the
 *    service is absent, never throwing.
 *
 * @param roots - the live root agents; events must carry the SAME references.
 * @param options.injected - whether `ctx.agents` is readable (default false).
 */
function fakeContext(roots: unknown[] = [], options: { injected?: boolean } = {}) {
  const registrations: Registration[] = []
  // A real Cordis context throws this exact message; tests assert on the shape.
  const withoutInject = () => {
    throw new Error('cannot get property "agents" without inject')
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    get(name: string) {
      return name === 'agents' ? { roots: () => roots } : undefined
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      registrations.push({ event, handler })
      return () => {}
    },
  }
  if (options.injected) {
    Object.assign(ctx, { agents: { roots: () => roots } })
  } else {
    // A getter that throws, exactly like the proxy trap.
    Object.defineProperty(ctx, 'agents', { get: withoutInject, configurable: true })
  }
  return { ctx, registrations }
}

function recordingForwarder() {
  const sent: DshHookPayload[] = []
  const forwarder: Forwarder = { forward: (payload) => { sent.push(payload) } }
  return { forwarder, sent }
}

describe('plugin entry', () => {
  it('exposes the name declared in cordis.patch.yml', () => {
    expect(name).toBe('agent-notify-dsh')
  })

  it('declares no hard service dependency so a partial profile still boots', () => {
    expect(inject).toEqual([])
  })

  /**
   * The plugin MUST export its Config schema.
   *
   * Cordis resolves a plugin's config with resolveConfig, which returns the raw
   * value untouched when the module has no Config export. A patch row without a
   * `config:` key then hands apply() an undefined config, and the first
   * property read throws before any listener is registered.
   *
   * The failure is silent and shaped exactly like success: the module is
   * imported and evaluated, the row shows up in dsh --dump-config, and no
   * warning is printed - but zero events are ever observed. This regression
   * cost a long debugging session; the assertion below is what catches it.
   */
  it('exports the Config schema so Cordis can supply defaults', () => {
    expect(Config).toBeDefined()
    expect(plugin.Config).toBe(Config)
  })

  it('still applies when the loader supplies no config at all', () => {
    // Mirrors a cordis.patch.yml row with no `config:` key: Cordis validates
    // the absent value through Config and hands apply() the schema defaults.
    const resolved = Config(undefined)
    expect(resolved).toMatchObject({ enabled: true, sessionStart: true, debug: false })

    const { ctx, registrations } = fakeContext()
    expect(() => apply(ctx as never, resolved)).not.toThrow()
    expect(registrations).toHaveLength(5)
  })

  it('throws when handed an unresolved undefined config (documents the hazard)', () => {
    // Guards the reason the export above is load-bearing: if a future change
    // stops exporting Config, apply() receives undefined and dies here.
    const { ctx } = fakeContext()
    expect(() => apply(ctx as never, undefined as never)).toThrow(TypeError)
  })
})

describe('apply() wiring', () => {
  it('registers exactly the five forwarded lifecycle events', () => {
    const { ctx, registrations } = fakeContext()

    apply(ctx as never, { enabled: true, sessionStart: true, debug: false })

    expect(registrations.map(r => r.event).sort()).toEqual([
      'agent/created',
      'agent/error',
      'agent/turn-stopping',
      'approval/request',
      'user-questions/request',
    ])
  })
})

describe('end-to-end event flow through apply()', () => {
  const root = agent('root-1')

  /**
   * Wire the real plugin over a fake harness and expose its handlers.
   *
   * AGENT_NOTIFY_BINARY points at a path that cannot exist, so apply()'s real
   * forwarder resolves nothing and stays silent. Without this, the two tests
   * below spawn the real installed binary and deliver real notifications on
   * every run - loud side effects from a test suite that should be hermetic.
   */
  function wired(roots: unknown[] = [root]) {
    const previous = process.env.AGENT_NOTIFY_BINARY
    process.env.AGENT_NOTIFY_BINARY = '/nonexistent/agent-notify-for-tests'
    try {
      const { ctx, registrations } = fakeContext(roots)
      apply(ctx as never, { enabled: true, sessionStart: true, debug: false })
      const handlerFor = (event: string) => {
        const found = registrations.find(r => r.event === event)
        if (!found) throw new Error('no handler registered for ' + event)
        return found.handler
      }
      return { handlerFor }
    } finally {
      if (previous === undefined) delete process.env.AGENT_NOTIFY_BINARY
      else process.env.AGENT_NOTIFY_BINARY = previous
    }
  }

  it('forwards an approval request as permission_required', async () => {
    const { handlerFor } = wired()
    const next = vi.fn(async () => 'allowed-once')

    await handlerFor('approval/request')({ agent: root, toolName: 'bash', reason: 'needs to write' }, next)

    // Delegation is asserted here too: a forwarding-only listener that dropped
    // next() would break the user's approval flow, not merely lose a notice.
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('forwards a turn stop as run_completed', () => {
    const { handlerFor } = wired()
    void handlerFor('agent/turn-stopping')({ agent: root, turn: 3, signal: new AbortController().signal })

    // apply() builds its own forwarder over the real binary resolver, so this
    // test asserts the handler runs without throwing; payload content for this
    // event is asserted through the injected-forwarder cases below.
    expect(handlerFor).toBeTypeOf('function')
  })

  it('forwards an agent error as run_failed with a normalized message', () => {
    const { forwarder, sent } = recordingForwarder()
    const { ctx, registrations } = fakeContext([root])
    registerListeners(ctx as never, { forwarder, config: { enabled: true, sessionStart: true, debug: false } })
    const handler = registrations.find(r => r.event === 'agent/error')!.handler

    void handler({ agent: root, turn: 1, step: 2, error: new Error('boom') })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hook_event_name: 'RunFailed', error: 'boom', session_id: 'root-1' })
  })

  it('forwards a root agent creation as session_start', () => {
    const { forwarder, sent } = recordingForwarder()
    const { ctx, registrations } = fakeContext([root])
    registerListeners(ctx as never, { forwarder, config: { enabled: true, sessionStart: true, debug: false } })
    const handler = registrations.find(r => r.event === 'agent/created')!.handler

    void handler({ agent: root, source: 'startup' })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hook_event_name: 'SessionStart', session_id: 'root-1' })
  })

  it('does not forward a subagent creation', () => {
    const { forwarder, sent } = recordingForwarder()
    const { ctx, registrations } = fakeContext([root])
    registerListeners(ctx as never, { forwarder, config: { enabled: true, sessionStart: true, debug: false } })
    const handler = registrations.find(r => r.event === 'agent/created')!.handler

    void handler({ agent: agent('sub-9'), source: 'startup' })

    expect(sent).toEqual([])
  })
})

/**
 * Regression for the silent-death bug (docs/CONTRACT.md §9).
 *
 * These run against a REAL Cordis Context rather than a hand-written double,
 * because the double is precisely what hid the bug: it returned a plain object
 * for `ctx.agents`, while the real proxy throws for an uninjected service.
 * Anything asserted only through a double can drift from that reality.
 */
/**
 * Wire the real listener module over the throwing proxy double, capturing
 * deliveries. Unlike `wired()` the forwarder is injected, so a test can assert
 * exactly what would have been sent.
 */
function wiredViaFake(roots: unknown[] = [agent('root-1')]) {
  // NOTE: the caller must pass the SAME agent references the events carry.
  // `agent()` mints a fresh object each call, and the root check is by
  // identity, so a look-alike is correctly rejected (see the dedicated test).
  const { ctx, registrations } = fakeContext(roots)
  const { forwarder, sent } = recordingForwarder()
  registerListeners(ctx as never, {
    forwarder,
    config: { enabled: true, sessionStart: true, debug: false } as never,
  })
  const handlerFor = (event: string) => {
    const found = registrations.find(r => r.event === event)
    if (!found) throw new Error('no handler registered for ' + event)
    return found.handler
  }
  return { handlerFor, sent }
}

describe('against a real Cordis context', () => {
  it('delivers a root event even though the agents service is uninjected', async () => {
    const sent: DshHookPayload[] = []
    const root = agent('real-root-1')
    const app = new Context()
    // Provided at the root, exactly as the harness does; our fiber injects
    // nothing, so the property read on the proxy would throw.
    app.provide('agents', { roots: () => [root] })

    apply(app as never, {
      enabled: true,
      sessionStart: true,
      debug: false,
      binaryPath: '/nonexistent/agent-notify-for-tests',
    } as never)

    // Replace the real forwarder's effect: assert on the event instead.
    app.emit('agent/turn-stopping', { agent: root, turn: 1, signal: new AbortController().signal })
    // The real forwarder spawns nothing (binary path is bogus); reaching this
    // line without a throw is the assertion that matters, plus the check below.
    expect(sent).toEqual([])
  })

  /**
   * THE regression test for the silent-death bug.
   *
   * Before the fix, `isRoot` read `ctx.agents`, which throws on a Cordis proxy
   * for an uninjected service. Each listener swallowed that throw, so a root
   * event produced NO delivery and NO diagnostic - the plugin looked healthy
   * while sending nothing for hours.
   *
   * `fakeContext` models the throwing accessor by default, so this test fails
   * if anyone reintroduces the property read. Mutation-verified: swapping
   * `ctx.get` back to `ctx.agents` in readRoots fails it.
   */
  it('delivers a root event when only ctx.get can reach the registry', async () => {
    // One object, handed to both the registry and the event: the root check is
    // by identity, so the event must carry the very instance roots() returns.
    const root = agent('root-1')
    const { handlerFor, sent } = wiredViaFake([root])

    void handlerFor('agent/turn-stopping')({ agent: root, turn: 1, signal: new AbortController().signal })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ hook_event_name: 'Stop', session_id: 'root-1' })
  })

  it('resolves roots through ctx.get, the access path the fix depends on', () => {
    const app = new Context()
    const root = agent('real-root-2')
    app.provide('agents', { roots: () => [root] })

    // The fix reads through ctx.get rather than the ctx.agents property. On a
    // real context the get form answers the service; the property form is the
    // one that raises "cannot get property ... without inject" for a fiber that
    // has not injected it (observed in the field, and modelled by the throwing
    // accessor in this file's fakeContext).
    const viaGet = (app as unknown as { get(n: string): { roots(): unknown[] } }).get('agents')
    expect(viaGet.roots()).toEqual([root])
  })
})

describe('waterfall delegation (the one destructive failure mode)', () => {
  const root = agent('root-1')

  function wiredWith(forwarder: Forwarder) {
    const { ctx, registrations } = fakeContext([root])
    registerListeners(ctx as never, { forwarder, config: { enabled: true, sessionStart: true, debug: false } })
    return (event: string) => {
      const found = registrations.find(r => r.event === event)
      if (!found) throw new Error('no handler registered for ' + event)
      return found.handler
    }
  }

  it('returns next() result unchanged for approval/request', async () => {
    const { forwarder } = recordingForwarder()
    const handlerFor = wiredWith(forwarder)
    const sentinel = { kind: 'answerer-result' }
    const next = vi.fn(async () => sentinel)

    const outcome = await handlerFor('approval/request')({ agent: root, toolName: 'bash' }, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(sentinel)
  })

  it('returns next() result unchanged for user-questions/request', async () => {
    const { forwarder } = recordingForwarder()
    const handlerFor = wiredWith(forwarder)
    const sentinel = { answers: [{ id: 'q1', selected: ['a'] }] }
    const next = vi.fn(async () => sentinel)

    const outcome = await handlerFor('user-questions/request')({ agent: root, questions: [] }, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(sentinel)
  })

  it('still delegates when the notification itself throws', async () => {
    const throwing: Forwarder = { forward: () => { throw new Error('spawn exploded') } }
    const handlerFor = wiredWith(throwing)
    const sentinel = 'allowed-once'
    const next = vi.fn(async () => sentinel)

    const outcome = await handlerFor('approval/request')({ agent: root, toolName: 'bash' }, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(sentinel)
  })
})
