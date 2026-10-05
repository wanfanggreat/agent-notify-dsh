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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Subcommand the Go binary exposes for DSH hook events (plan §3.1). */
const HOOK_SUBCOMMAND = 'handle-dsh-hook';
/** Environment variable that overrides the install-location lookup. */
const ENV_BINARY = 'AGENT_NOTIFY_BINARY';
/** Directory shared by the npx launcher and `make local`. */
const INSTALL_DIR = '.agent-notify';
/** Installed binary name on POSIX platforms. */
const BINARY_NAME = 'agent-notify';
/** Installed binary name on Windows. */
const WINDOWS_BINARY_NAME = 'agent-notify.exe';
/** True for a string that is present and not merely whitespace. */
function isUsable(value) {
    return typeof value === 'string' && value.trim() !== '';
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
export function resolveBinary(options) {
    try {
        const explicit = options?.binaryPath;
        if (isUsable(explicit))
            return explicit;
        const fromEnv = (options?.env ?? process.env)[ENV_BINARY];
        if (isUsable(fromEnv))
            return fromEnv;
        const home = options?.home ?? homedir();
        if (!isUsable(home))
            return null;
        const installed = join(home, INSTALL_DIR, process.platform === 'win32' ? WINDOWS_BINARY_NAME : BINARY_NAME);
        return existsSync(installed) ? installed : null;
    }
    catch {
        // Only level 3 touches the filesystem, so a throw here means "malformed
        // path": that is a missing binary, not a broken plugin.
        return null;
    }
}
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
export function createForwarder(options = {}) {
    const debug = (message) => {
        try {
            options.onDebug?.(message);
        }
        catch {
            // A diagnostic sink must never be able to break delivery.
        }
    };
    return {
        forward(payload) {
            try {
                const binary = resolveBinary(options);
                if (binary === null) {
                    debug(`agent-notify binary not found; dropped ${payload.hook_event_name}`);
                    return;
                }
                const line = JSON.stringify(payload);
                // Typed as string, but a plain-JS caller can hand us a value that
                // stringify cannot represent.
                if (typeof line !== 'string') {
                    debug('agent-notify payload was not serializable; dropped event');
                    return;
                }
                const child = spawn(binary, [HOOK_SUBCOMMAND], {
                    stdio: ['pipe', 'ignore', 'ignore'],
                    detached: true,
                });
                // A failed exec (ENOENT/EACCES) is reported asynchronously; without a
                // listener Node would turn it into an uncaught exception.
                child.on('error', () => { });
                // The same failure destroys stdin, and the write below would then emit
                // 'error' on the stream.
                child.stdin?.on('error', () => { });
                try {
                    child.stdin?.write(`${line}\n`);
                    child.stdin?.end();
                }
                finally {
                    // unref even when the write failed: a referenced child would keep
                    // the host's event loop alive.
                    child.unref();
                }
            }
            catch (error) {
                debug(`agent-notify forward failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
}
