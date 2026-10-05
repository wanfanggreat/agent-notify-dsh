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
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import type { Forwarder } from './types.js';
/**
 * Injection seam and configuration for {@link registerListeners}.
 */
export interface RegisterOptions {
    /**
     * Delivery seam (docs/CONTRACT.md §3). Injected rather than imported so no
     * listener depends on the process-spawning module, and so tests can record
     * deliveries without spawning anything.
     */
    forwarder: Forwarder;
    /**
     * Validated plugin configuration. `enabled: false` suppresses every delivery
     * while still registering all listeners; `sessionStart: false` suppresses
     * only the `SessionStart` event, which exists solely for click-to-focus
     * window capture.
     */
    config: Config;
    /**
     * Root-agent predicate. Defaults to the registry
     * (`ctx.agents?.roots().includes(agent) ?? false`); tests inject a
     * deterministic stand-in so they need no live registry.
     *
     * @param ctx - the context this plugin was registered on.
     * @param agent - the event's agent, as received (unvalidated).
     */
    isRoot?: (ctx: Context, agent: unknown) => boolean;
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
export declare function registerListeners(ctx: Context, options: RegisterOptions): void;
