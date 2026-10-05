/**
 * Binary resolution and detached delivery — the only side-effecting module.
 *
 * Two disciplines drive every line here:
 *
 * 1. Resolution degrades instead of failing. A plugin that cannot find the
 *    binary has nothing to say; it must not break the host that loaded it.
 * 2. Delivery never blocks and never throws. The events come from an agent
 *    mid-turn (`agent/created` is awaited by DSH), so a notification that
 *    threw would corrupt the very run it reports on.
 *
 * The spawn shape mirrors the pattern already validated by the OpenCode plugin
 * (`internal/opencodehooks/plugin/opencode.js:39-46` in agent-notify).
 * @module agent-notify-dsh/spawn
 */
import type { Forwarder } from './types.js';
/** Knobs for {@link resolveBinary} and {@link createForwarder}. */
export interface SpawnOptions {
    /** Overrides level 1 of binary resolution (default: read the env var). */
    binaryPath?: string;
    /** Home directory used for level 3 (default `os.homedir()`); tests inject it to avoid depending on the real HOME. */
    home?: string;
    /** Environment used for level 2 (default `process.env`). */
    env?: NodeJS.ProcessEnv;
    /** Diagnostic sink; silent by default. */
    onDebug?: (message: string) => void;
}
/**
 * Locate the agent-notify binary using the fixed three-level ladder of
 * docs/CONTRACT.md §2.
 *
 * 1. `options.binaryPath` (non-blank) — explicit plugin configuration.
 * 2. `AGENT_NOTIFY_BINARY` from `options.env` (default `process.env`).
 * 3. `<home>/.agent-notify/agent-notify` (`agent-notify.exe` on Windows).
 *
 * Levels 1 and 2 are taken on trust ("非空即用") so `make local` and tests can
 * point at an arbitrary path; level 3 is the install location and therefore has
 * to actually exist. When nothing resolves the result is `null`, never a throw.
 *
 * @param options - optional overrides; all levels are injectable for testing.
 * @returns the resolved absolute path, or `null` when the binary is not found.
 */
export declare function resolveBinary(options?: Pick<SpawnOptions, 'binaryPath' | 'home' | 'env'>): string | null;
/**
 * Build the {@link Forwarder} the listeners write through.
 *
 * `forward()` resolves the binary on every call (so installing agent-notify
 * after DSH started starts working without a restart), then hands the payload
 * to a detached child on stdin as a single JSON line and walks away: the child
 * is unref'd, both stdio ends are silenced, and every failure — synchronous or
 * asynchronous — is swallowed.
 *
 * @param options - binary resolution overrides plus the optional debug sink.
 * @returns a forwarder whose `forward` returns synchronously and never throws.
 */
export declare function createForwarder(options?: SpawnOptions): Forwarder;
