/**
 * Cordis plugin entry: wires the forwarder and listeners onto the harness.
 *
 * This module is assembly only - it owns no event mapping and no process
 * work. Everything testable lives in the sibling modules so that a failing
 * test points at a unit rather than at the plugin boundary
 * (see docs/CONTRACT.md §3).
 * @module agent-notify-dsh
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import { registerListeners } from './listeners.js'
import { createForwarder } from './spawn.js'

/**
 * The plugin name the harness registers this entry under. Must match the
 * `name` field of the `insert` row in cordis.patch.yml.
 */
export const name = 'agent-notify-dsh'

/**
 * No hard service dependency is declared.
 *
 * The plugin must load even when `agents` is absent, so that a profile
 * missing that service still boots instead of failing on our account. The
 * root-agent check reads the service optionally and treats its absence as
 * "not a root", which degrades to silence rather than to an error.
 */
export const inject: string[] = []

/**
 * Register the plugin.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - validated plugin configuration; schemastery supplies defaults.
 */
export function apply(ctx: Context, config: Config): void {
  const forwarder = createForwarder({
    ...config.binaryPath !== undefined ? { binaryPath: config.binaryPath } : {},
    ...config.debug ? { onDebug: (message: string) => { ctx.logger.info(message) } } : {},
  })

  registerListeners(ctx, { forwarder, config })
}
