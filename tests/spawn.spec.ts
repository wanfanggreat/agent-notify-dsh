/**
 * Unit tests for binary resolution and delivery.
 *
 * `node:child_process` is mocked for the whole file: no test here may start a
 * real process. Assertions cover the pure three-level ladder and the exact
 * spawn discipline (detached, piped stdin, one newline-terminated JSON line,
 * unref, swallowed errors).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createForwarder, resolveBinary } from '../src/spawn.ts'
import type { DshHookPayload } from '../src/types.ts'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

interface FakeChild {
  on: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
  stdin: {
    on: ReturnType<typeof vi.fn>
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
}

/** A stand-in for the ChildProcess that `spawn` returns. */
function makeChild(): FakeChild {
  return {
    on: vi.fn(),
    unref: vi.fn(),
    stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
  }
}

/** Create `<home>/.agent-notify/<name>` and return its path. */
function installBinary(home: string, name = 'agent-notify'): string {
  const dir = join(home, '.agent-notify')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, name)
  writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return target
}

const PAYLOAD: DshHookPayload = {
  hook_event_name: 'ApprovalRequest',
  session_id: 'sess_test',
  cwd: '/workspace',
  tool_name: 'bash',
  reason: 'needs approval',
}

const BINARY = '/opt/agent-notify/agent-notify'

let home: string
let tempDirs: string[]

beforeEach(() => {
  spawnMock.mockReset()
  tempDirs = []
  home = mkdtempSync(join(tmpdir(), 'agent-notify-dsh-spawn-'))
  tempDirs.push(home)
})

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('resolveBinary', () => {
  it('prefers the explicit binaryPath over env and the install location', () => {
    installBinary(home)
    expect(
      resolveBinary({
        binaryPath: '/opt/custom/agent-notify',
        env: { AGENT_NOTIFY_BINARY: '/from/env/agent-notify' },
        home,
      }),
    ).toBe('/opt/custom/agent-notify')
  })

  it('falls back to AGENT_NOTIFY_BINARY when binaryPath is absent or blank', () => {
    installBinary(home)
    const env = { AGENT_NOTIFY_BINARY: '/from/env/agent-notify' }
    expect(resolveBinary({ env, home })).toBe('/from/env/agent-notify')
    expect(resolveBinary({ binaryPath: '   ', env, home })).toBe('/from/env/agent-notify')
  })

  it('falls back to <home>/.agent-notify/agent-notify', () => {
    const installed = installBinary(home)
    expect(resolveBinary({ env: {}, home })).toBe(installed)
  })

  it('returns null when no level resolves, and never throws', () => {
    expect(() => resolveBinary({ env: {}, home })).not.toThrow()
    expect(resolveBinary({ env: {}, home })).toBeNull()
    expect(
      resolveBinary({ binaryPath: '', env: { AGENT_NOTIFY_BINARY: '' }, home }),
    ).toBeNull()
  })

  it('reads process.env when no env is injected', () => {
    const previous = process.env.AGENT_NOTIFY_BINARY
    process.env.AGENT_NOTIFY_BINARY = '/from/process-env/agent-notify'
    try {
      expect(resolveBinary({ home })).toBe('/from/process-env/agent-notify')
    } finally {
      if (previous === undefined) delete process.env.AGENT_NOTIFY_BINARY
      else process.env.AGENT_NOTIFY_BINARY = previous
    }
  })

  it('looks for agent-notify.exe on Windows', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    try {
      installBinary(home, 'agent-notify')
      expect(resolveBinary({ env: {}, home })).toBeNull()
      const exe = installBinary(home, 'agent-notify.exe')
      expect(resolveBinary({ env: {}, home })).toBe(exe)
    } finally {
      platform.mockRestore()
    }
  })
})

describe('createForwarder', () => {
  it('spawns the resolved binary detached with piped stdin', () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    createForwarder({ binaryPath: BINARY }).forward(PAYLOAD)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(BINARY, ['handle-dsh-hook'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('swallows spawn failures by listening for error on the child and its stdin', () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    createForwarder({ binaryPath: BINARY }).forward(PAYLOAD)

    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child.stdin.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('writes exactly one JSON line, then ends stdin', () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)
    createForwarder({ binaryPath: BINARY }).forward(PAYLOAD)

    expect(child.stdin.write).toHaveBeenCalledTimes(1)
    const written = child.stdin.write.mock.calls[0]?.[0]
    expect(typeof written).toBe('string')
    expect(written.endsWith('\n')).toBe(true)
    // Exactly one line: a second newline would make the Go side see two events.
    expect(written.slice(0, -1)).not.toContain('\n')
    expect(JSON.parse(written)).toEqual(PAYLOAD)
    expect(child.stdin.end).toHaveBeenCalledTimes(1)
    expect(child.stdin.write.mock.invocationCallOrder[0]).toBeLessThan(
      child.stdin.end.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('returns synchronously', () => {
    spawnMock.mockReturnValue(makeChild())
    const returned = createForwarder({ binaryPath: BINARY }).forward(PAYLOAD)
    expect(returned).toBeUndefined()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('never throws when spawn throws', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EACCES')
    })
    const forwarder = createForwarder({ binaryPath: BINARY })
    expect(() => forwarder.forward(PAYLOAD)).not.toThrow()
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('drops the event quietly when no binary resolves', () => {
    const forwarder = createForwarder({ env: {}, home })
    expect(resolveBinary({ env: {}, home })).toBeNull()
    expect(() => forwarder.forward(PAYLOAD)).not.toThrow()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('stays silent by default and reports through onDebug when asked', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    createForwarder({ env: {}, home }).forward(PAYLOAD)
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()

    const onDebug = vi.fn()
    createForwarder({ env: {}, home, onDebug }).forward(PAYLOAD)
    expect(onDebug).toHaveBeenCalledTimes(1)
    expect(onDebug.mock.calls[0]?.[0]).toMatch(/not found/)
  })

  it('swallows a synchronous stdin write failure and still unrefs the child', () => {
    const child = makeChild()
    child.stdin.write.mockImplementation(() => {
      throw new Error('EPIPE')
    })
    spawnMock.mockReturnValue(child)
    const forwarder = createForwarder({ binaryPath: BINARY })
    expect(() => forwarder.forward(PAYLOAD)).not.toThrow()
    // A referenced child would keep the host's event loop alive.
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('swallows a payload that cannot be serialized', () => {
    const circular: Record<string, unknown> = {
      hook_event_name: 'Stop',
      session_id: 'sess_test',
      cwd: '/workspace',
    }
    circular.self = circular
    const onDebug = vi.fn()
    const forwarder = createForwarder({ binaryPath: BINARY, onDebug })
    expect(() =>
      forwarder.forward(circular as unknown as DshHookPayload),
    ).not.toThrow()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(onDebug).toHaveBeenCalledTimes(1)
  })

  it('tolerates a throwing onDebug sink', () => {
    const onDebug = vi.fn(() => {
      throw new Error('logger exploded')
    })
    const forwarder = createForwarder({ env: {}, home, onDebug })
    expect(() => forwarder.forward(PAYLOAD)).not.toThrow()
    expect(onDebug).toHaveBeenCalled()
  })
});
