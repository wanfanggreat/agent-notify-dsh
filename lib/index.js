/**
 * Cordis plugin entry: wires the forwarder and listeners onto the harness.
 *
 * This module is assembly only - it owns no event mapping and no process
 * work. Everything testable lives in the sibling modules so that a failing
 * test points at a unit rather than at the plugin boundary
 * (see docs/CONTRACT.md §3).
 * @module agent-notify-dsh
 */
import { Config } from './config.js';
import { registerListeners } from './listeners.js';
import { createForwarder } from './spawn.js';
/**
 * The plugin name the harness registers this entry under. Must match the
 * `name` field of the `insert` row in cordis.patch.yml.
 */
export const name = 'agent-notify-dsh';
/**
 * The configuration schema, re-exported under the name Cordis looks for.
 *
 * This export is load-bearing, not a convenience. Cordis resolves a plugin's
 * config with `resolveConfig`, which returns the raw value untouched when the
 * module has no `Config` export:
 *
 *     function resolveConfig(runtime, config) {
 *       if (!runtime.Config) return config
 *       ...
 *     }
 *
 * A patch row that omits `config:` then delivers `undefined` to `apply`, and
 * the first property read (`config.binaryPath`) throws a TypeError before any
 * listener is registered. The plugin appears to load - its module is imported
 * and evaluated - while silently observing nothing at all.
 *
 * Exporting the schema makes Cordis validate the absent value into the
 * schema's defaults instead, so a row without `config:` works as intended.
 * Every DSH-shipped plugin exports its Config for this reason.
 */
export { Config };
/**
 * No hard service dependency is declared.
 *
 * The plugin must load even when `agents` is absent, so that a profile
 * missing that service still boots instead of failing on our account. The
 * root-agent check reads the service optionally and treats its absence as
 * "not a root", which degrades to silence rather than to an error.
 */
export const inject = [];
/**
 * Register the plugin.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - validated plugin configuration; schemastery supplies defaults.
 */
export function apply(ctx, config) {
    const forwarder = createForwarder({
        ...config.binaryPath !== undefined ? { binaryPath: config.binaryPath } : {},
        ...config.debug ? { onDebug: (message) => { ctx.logger.info(message); } } : {},
    });
    registerListeners(ctx, { forwarder, config });
}
