/**
 * Plugin configuration schema.
 *
 * Config is validated by schemastery (the DSH convention) and read once at
 * load. Values are deployment-varying, so they live here rather than as
 * hardcoded constants (the harness "no hardcoded tunables" rule).
 * @module agent-notify-dsh/config
 */

import z from '@deepseek-ai/schemastery'

/** Plugin configuration. Every field has a default, so `{}` is valid. */
export interface Config {
  /**
   * Enable forwarding. When false every listener is still registered but
   * delivers nothing — useful for measuring listener overhead in isolation.
   * @default true
   */
  enabled: boolean
  /**
   * Absolute path to the agent-notify binary. When omitted, resolution falls
   * back to `AGENT_NOTIFY_BINARY` and then `~/.agent-notify/agent-notify`.
   * @default undefined
   */
  binaryPath?: string
  /**
   * Forward `agent/created` as `SessionStart`. It never notifies; it exists so
   * the Go side can capture the click-to-focus window for the session.
   * @default true
   */
  sessionStart: boolean
  /**
   * Print one diagnostic line per delivery to the plugin logger. Off by default
   * so a normal run stays quiet.
   * @default false
   */
  debug: boolean
}

/** Runtime-validated configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  binaryPath: z.string(),
  sessionStart: z.boolean().default(true),
  debug: z.boolean().default(false),
})
