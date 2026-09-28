/**
 * Registration of the five DSH lifecycle listeners this plugin observes.
 *
 * This module carries the project's only *destructive* failure mode, so its
 * rules are mechanical rather than stylistic (docs/CONTRACT.md §4):
 *
 * 1. `approval/request` and `user-questions/request` are Cordis **waterfalls**.
 *    Each must delegate unconditionally with `return next()`, and that return
 *    must sit OUTSIDE the try/catch that contains notification. Awaiting the
 *    delegation, swallowing it, or rewriting its value would hijack the user's
 *    approval flow rather than merely lose a notice.
 * 2. Every listener body contains its own failures. `agent/created` is awaited
 *    by the harness, so a throw there fails session creation, not just a notice.
 * 3. Only root agents notify. `Agent` exposes no parent/root field: ownership
 *    lives in the registry's private `entry.owner` and is observable only
 *    through `ctx.agents.roots()`, which is read *optionally* because `inject`
 *    is empty and the service may legitimately be absent.
 *
 * Dependencies (docs/CONTRACT.md §3): this module may import `config.ts`,
 * `payload.ts` and `types.ts`; it must never import `spawn.ts` (the side
 * effect) or reach for the harness's side effects directly.
 *
 * @module agent-notify-dsh/listeners
 */

import type { Context } from '@deepseek-ai/cordis'
/*
 * Type-only, side-effect-bearing module references.
 *
 * Cordis declares `interface Events` in `@deepseek-ai/cordis` and each harness
 * package augments it from its own declarations. A plugin that calls
 * `ctx.on('agent/created', ...)` therefore has to have that package's types in
 * the program, or `keyof Events` contains no lifecycle events at all and the
 * registration stops being type-checked (or fails to compile).
 *
 * These imports are erased at build time (`import type`), so the shipped plugin
 * still has no runtime dependency beyond cordis: the harness supplies its own
 * packages.
 */
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { Config } from './config.js'
import {
  approvalPayload,
  errorPayload,
  questionPayload,
  sessionStartPayload,
  stopPayload,
  type AgentLike,
  type ApprovalLike,
  type QuestionLike,
} from './payload.js'
import type { DshHookPayload, Forwarder } from './types.js'

/**
 * The projection of `agent/created` this module reads.
 *
 * Deliberately structural and minimal instead of importing `dsh-agent`'s full
 * `Agent`: the listener only ever needs the addressing fields, and a test can
 * therefore trigger it with a plain object.
 */
interface AgentCreatedEvent {
  /** The newly created agent (root check + `session_id`/`cwd` source). */
  readonly agent: AgentLike
}

/** The projection of `agent/turn-stopping` this module reads. */
interface TurnStoppingEvent {
  /** The agent whose turn is at its stop boundary. */
  readonly agent: AgentLike
}

/** The projection of `agent/error` this module reads. */
interface AgentErrorEvent {
  /** The agent whose turn errored. */
  readonly agent: AgentLike
  /** The failure, verbatim; normalized by {@link errorPayload}. */
  readonly error?: unknown
}

/**
 * Injection seam and configuration for {@link registerListeners}.
 */
export interface RegisterOptions {
  /**
   * Delivery seam (docs/CONTRACT.md §3). Injected rather than imported so no
   * listener depends on the process-spawning module, and so tests can record
   * deliveries without spawning anything.
   */
  forwarder: Forwarder
  /**
   * Validated plugin configuration. `enabled: false` suppresses every delivery
   * while still registering all listeners; `sessionStart: false` suppresses
   * only the `SessionStart` event, which exists solely for click-to-focus
   * window capture.
   */
  config: Config
  /**
   * Root-agent predicate. Defaults to the registry
   * (`ctx.agents?.roots().includes(agent) ?? false`); tests inject a
   * deterministic stand-in so they need no live registry.
   *
   * @param ctx - the context this plugin was registered on.
   * @param agent - the event's agent, as received (unvalidated).
   */
  isRoot?: (ctx: Context, agent: unknown) => boolean
}

/**
 * Register the five lifecycle listeners on the plugin context.
 *
 * Listener disposers are owned by the calling fiber (`ctx.on` returns one each,
 * and Cordis disposes them with the context), so this function returns nothing:
 * there is no separate lifetime to manage at the call site.
 *
 * @param ctx - the plugin's Cordis context.
 * @param options - forwarder, validated config, and the optional root predicate.
 */
export function registerListeners(ctx: Context, options: RegisterOptions): void {
  const { forwarder, config } = options
  const isRoot = options.isRoot ?? defaultIsRoot

  /**
   * Deliver one payload, honoring the global switch.
   *
   * Must only ever be called from inside a listener's `try` block: this is the
   * single line that can run foreign code (the forwarder), and a notification
   * is never allowed to disturb the agent it reports on.
   */
  const notify = (payload: DshHookPayload): void => {
    // Compared against `false` rather than `true`: the schema defaults
    // `enabled` to true, so an absent value means "on" (config.ts).
    if (config?.enabled === false) return
    forwarder.forward(payload)
  }

  /**
   * `agent/created` (serial, awaited by the harness).
   *
   * Never throws: a rejection here fails session creation. Forwarded as
   * `SessionStart`, which the Go side consumes for focus capture only.
   */
  const onAgentCreated = (payload: AgentCreatedEvent): undefined => {
    try {
      const agent = payload?.agent
      if (config?.sessionStart !== false && isRoot(ctx, agent)) {
        notify(sessionStartPayload(agent))
      }
    } catch {
      // Swallowed by design (CONTRACT §4.2).
    }
    return undefined
  }

  /**
   * `approval/request` (waterfall).
   *
   * The notification is a side observation of a decision this plugin has no
   * vote in: it must never claim, delay, or alter the request.
   */
  const onApprovalRequest = <T>(request: ApprovalLike, next: () => Promise<T>): Promise<T> => {
    try {
      if (isRoot(ctx, request?.agent)) notify(approvalPayload(request))
    } catch {
      // Swallowed by design (CONTRACT §4.2).
    }
    // Outside the try, unconditional, un-awaited: the caller receives next()'s
    // own promise, so a synchronous throw from next() propagates unchanged and
    // a rejection keeps its identity. Removing or moving this line breaks DSH.
    return next()
  }

  /**
   * `user-questions/request` (waterfall).
   *
   * Same discipline as {@link onApprovalRequest}: the human's answer must reach
   * the asker exactly as the rest of the chain produced it.
   */
  const onUserQuestionsRequest = <T>(request: QuestionLike, next: () => Promise<T>): Promise<T> => {
    try {
      if (isRoot(ctx, request?.agent)) notify(questionPayload(request))
    } catch {
      // Swallowed by design (CONTRACT §4.2).
    }
    // Outside the try, unconditional, un-awaited. See onApprovalRequest.
    return next()
  }

  /**
   * `agent/turn-stopping` (serial): the turn finished, so this becomes the
   * `Stop` / `run_completed` notification.
   */
  const onTurnStopping = (payload: TurnStoppingEvent): void => {
    try {
      const agent = payload?.agent
      if (isRoot(ctx, agent)) notify(stopPayload(agent))
    } catch {
      // Swallowed by design (CONTRACT §4.2).
    }
  }

  /**
   * `agent/error` (emit): a step or turn failed.
   *
   * Filtered like the rest: a child agent's failure must not be reported as the
   * main task's failure, which would page a human for a retried subagent.
   */
  const onAgentError = (payload: AgentErrorEvent): void => {
    try {
      const agent = payload?.agent
      if (isRoot(ctx, agent)) notify(errorPayload(agent, payload?.error))
    } catch {
      // Swallowed by design (CONTRACT §4.2).
    }
  }

  ctx.on('agent/created', onAgentCreated)
  ctx.on('approval/request', onApprovalRequest)
  ctx.on('user-questions/request', onUserQuestionsRequest)
  ctx.on('agent/turn-stopping', onTurnStopping)
  ctx.on('agent/error', onAgentError)
}

/**
 * Default root-agent predicate: membership in the registry's live top-level
 * agents.
 *
 * Two properties are load-bearing:
 *
 * - The optional access. `inject` is empty (index.ts), so the plugin must load
 *   with no `agents` service at all, and then degrade to silence instead of
 *   throwing during `apply()`.
 * - The identity comparison. `roots()` returns the registry's own instances, so
 *   only the exact live agent counts as root; a structural look-alike (e.g. a
 *   subagent that copied a root's header) must not pass. Durable session lineage
 *   (`header.parentSession`) is not runtime ownership and is deliberately not
 *   consulted.
 *
 * @param ctx - the plugin's Cordis context.
 * @param agent - the event's agent, as received.
 * @returns whether the registry currently holds that exact agent as a root.
 */
function defaultIsRoot(ctx: Context, agent: unknown): boolean {
  const roots: readonly unknown[] | undefined = ctx.agents?.roots()
  return roots?.includes(agent) ?? false
}
