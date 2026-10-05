/**
 * Plugin configuration schema.
 *
 * Config is validated by schemastery (the DSH convention) and read once at
 * load. Values are deployment-varying, so they live here rather than as
 * hardcoded constants (the harness "no hardcoded tunables" rule).
 * @module agent-notify-dsh/config
 */
import z from '@deepseek-ai/schemastery';
/** Runtime-validated configuration. */
export const Config = z.object({
    enabled: z.boolean().default(true),
    binaryPath: z.string(),
    sessionStart: z.boolean().default(true),
    debug: z.boolean().default(false),
});
