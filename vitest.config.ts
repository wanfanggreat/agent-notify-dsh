import { defineConfig } from 'vitest/config'

/**
 * Test configuration for the plugin.
 *
 * Tests exercise source directly (no build step), so a failing test always
 * points at authored code rather than a stale `lib/` artifact.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    restoreMocks: true,
  },
})
