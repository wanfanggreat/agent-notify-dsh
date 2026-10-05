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
import { approvalPayload, errorPayload, questionPayload, sessionStartPayload, stopPayload, } from './payload.js';
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
export function registerListeners(ctx, options) {
    const { forwarder, config } = options;
    const isRoot = options.isRoot ?? defaultIsRoot;
    /**
     * Deliver one payload, honoring the global switch.
     *
     * Must only ever be called from inside a listener's `try` block: this is the
     * single line that can run foreign code (the forwarder), and a notification
     * is never allowed to disturb the agent it reports on.
     */
    const notify = (payload) => {
        // Compared against `false` rather than `true`: the schema defaults
        // `enabled` to true, so an absent value means "on" (config.ts).
        if (config?.enabled === false)
            return;
        forwarder.forward(payload);
    };
    /**
     * `agent/created` (serial, awaited by the harness).
     *
     * Never throws: a rejection here fails session creation. Forwarded as
     * `SessionStart`, which the Go side consumes for focus capture only.
     */
    const onAgentCreated = (payload) => {
        try {
            const agent = payload?.agent;
            if (config?.sessionStart !== false && isRoot(ctx, agent)) {
                notify(sessionStartPayload(agent));
            }
        }
        catch {
            // Swallowed by design (CONTRACT §4.2).
        }
        return undefined;
    };
    /**
     * `approval/request` (waterfall).
     *
     * The notification is a side observation of a decision this plugin has no
     * vote in: it must never claim, delay, or alter the request.
     */
    const onApprovalRequest = (request, next) => {
        try {
            if (isRoot(ctx, request?.agent))
                notify(approvalPayload(request));
        }
        catch {
            // Swallowed by design (CONTRACT §4.2).
        }
        // Outside the try, unconditional, un-awaited: the caller receives next()'s
        // own promise, so a synchronous throw from next() propagates unchanged and
        // a rejection keeps its identity. Removing or moving this line breaks DSH.
        return next();
    };
    /**
     * `user-questions/request` (waterfall).
     *
     * Same discipline as {@link onApprovalRequest}: the human's answer must reach
     * the asker exactly as the rest of the chain produced it.
     */
    const onUserQuestionsRequest = (request, next) => {
        try {
            if (isRoot(ctx, request?.agent))
                notify(questionPayload(request));
        }
        catch {
            // Swallowed by design (CONTRACT §4.2).
        }
        // Outside the try, unconditional, un-awaited. See onApprovalRequest.
        return next();
    };
    /**
     * `agent/turn-stopping` (serial): the turn finished, so this becomes the
     * `Stop` / `run_completed` notification.
     */
    const onTurnStopping = (payload) => {
        try {
            const agent = payload?.agent;
            if (isRoot(ctx, agent))
                notify(stopPayload(agent));
        }
        catch {
            // Swallowed by design (CONTRACT §4.2).
        }
    };
    /**
     * `agent/error` (emit): a step or turn failed.
     *
     * Filtered like the rest: a child agent's failure must not be reported as the
     * main task's failure, which would page a human for a retried subagent.
     */
    const onAgentError = (payload) => {
        try {
            const agent = payload?.agent;
            if (isRoot(ctx, agent))
                notify(errorPayload(agent, payload?.error));
        }
        catch {
            // Swallowed by design (CONTRACT §4.2).
        }
    };
    ctx.on('agent/created', onAgentCreated);
    ctx.on('approval/request', onApprovalRequest);
    ctx.on('user-questions/request', onUserQuestionsRequest);
    ctx.on('agent/turn-stopping', onTurnStopping);
    ctx.on('agent/error', onAgentError);
}
/**
 * Default root-agent predicate: membership in the registry's live top-level
 * agents.
 *
 * Two properties are load-bearing:
 *
 * - The identity comparison. `roots()` returns the registry's own instances, so
 *   only the exact live agent counts as root; a structural look-alike (e.g. a
 *   subagent that copied a root's header) must not pass. Durable session lineage
 *   (`header.parentSession`) is not runtime ownership and is deliberately not
 *   consulted.
 * - The failure direction. An unreadable registry yields `true` (deliver), never
 *   `false` (stay silent). See {@link readRoots}.
 *
 * @param ctx - the plugin's Cordis context.
 * @param agent - the event's agent, as received.
 * @returns whether the registry currently holds that exact agent as a root, or
 *   `true` when the registry cannot be read at all.
 */
function defaultIsRoot(ctx, agent) {
    const roots = readRoots(ctx);
    // Unreadable registry: assume root and deliver. Silence is precisely the
    // failure mode this branch exists to prevent - see docs/CONTRACT.md §9.
    if (roots === undefined)
        return true;
    return roots.includes(agent);
}
/**
 * Read the live root agents, or `undefined` when the registry is unreachable.
 *
 * `ctx.get('agents')` rather than `ctx.agents`, and the difference is
 * load-bearing. A Cordis context is a proxy whose `get` trap THROWS for a
 * service the fiber has not injected:
 *
 *     cannot get property "agents" without inject
 *
 * Optional chaining does not help: `?.` short-circuits on a nullish *value*,
 * never on a property access that throws. With the property form every
 * listener's `isRoot` call threw inside its own mandated try/catch, which
 * swallowed it - so the plugin registered all five listeners, received every
 * event, and silently delivered nothing. `ctx.get` reads the store directly and
 * answers `undefined` for an absent service instead.
 *
 * `inject: []` is deliberate (index.ts), so the service may legitimately be
 * invisible here; that is the case this tolerates rather than the case it fears.
 *
 * @param ctx - the plugin's Cordis context.
 * @returns the root agents, or `undefined` when they cannot be read.
 */
function readRoots(ctx) {
    try {
        const agents = ctx.get?.('agents');
        const roots = agents?.roots?.();
        return Array.isArray(roots) ? roots : undefined;
    }
    catch {
        return undefined;
    }
}
