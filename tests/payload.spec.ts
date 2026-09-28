/**
 * Unit tests for the pure payload builders.
 *
 * Imports source directly (never `lib/`) so a failure always points at authored
 * code, per vitest.config.ts.
 */

import { describe, expect, it } from 'vitest'

import {
  approvalPayload,
  errorPayload,
  questionPayload,
  sessionRef,
  sessionStartPayload,
  stopPayload,
  type AgentLike,
  type ApprovalLike,
  type QuestionLike,
} from '../src/payload.ts'

/** A complete projection, as `agent/created` hands one over. */
const agent: AgentLike = {
  session: { header: { id: 'sess_root_1', cwd: '/workspace/project' } },
}

/** Same agent, but the session header carries no cwd. */
const agentWithoutCwd: AgentLike = {
  session: { header: { id: 'sess_no_cwd' } },
}

const questions: QuestionLike = {
  agent,
  questions: [{ question: 'Deploy to production?' }, { question: 'Second question' }],
}

describe('sessionRef', () => {
  it('extracts the session id and cwd from the agent projection', () => {
    expect(sessionRef(agent)).toEqual({ session_id: 'sess_root_1', cwd: '/workspace/project' })
  })

  it('degrades to an empty id and process.cwd() when no agent is available', () => {
    expect(sessionRef(undefined)).toEqual({ session_id: '', cwd: process.cwd() })
  })

  it('falls back to process.cwd() when the header carries no cwd', () => {
    expect(sessionRef(agentWithoutCwd)).toEqual({ session_id: 'sess_no_cwd', cwd: process.cwd() })
  })

  it('treats an empty id the same as a missing one', () => {
    const empty: AgentLike = { session: { header: { id: '', cwd: '/w' } } }
    expect(sessionRef(empty)).toEqual({ session_id: '', cwd: '/w' })
  })
})

describe('sessionStartPayload', () => {
  it('builds a SessionStart payload addressing the root agent', () => {
    expect(sessionStartPayload(agent)).toEqual({
      hook_event_name: 'SessionStart',
      session_id: 'sess_root_1',
      cwd: '/workspace/project',
    })
  })

  it('carries no optional fields at all', () => {
    expect(Object.keys(sessionStartPayload(agent)).sort()).toEqual([
      'cwd',
      'hook_event_name',
      'session_id',
    ])
  })

  it('degrades when the header has no cwd', () => {
    expect(sessionStartPayload(agentWithoutCwd)).toEqual({
      hook_event_name: 'SessionStart',
      session_id: 'sess_no_cwd',
      cwd: process.cwd(),
    })
  })
})

describe('approvalPayload', () => {
  it('builds an ApprovalRequest payload with the tool name and explicit reason', () => {
    const req: ApprovalLike = {
      agent,
      toolName: 'bash',
      reason: 'needs to run the test suite',
    }

    expect(approvalPayload(req)).toEqual({
      hook_event_name: 'ApprovalRequest',
      session_id: 'sess_root_1',
      cwd: '/workspace/project',
      tool_name: 'bash',
      reason: 'needs to run the test suite',
    })
  })

  it('falls back to displayReason.en when reason is absent', () => {
    const req: ApprovalLike = {
      agent,
      toolName: 'write',
      displayReason: { en: 'Requested by the planner', 'zh-CN': '由规划器请求' },
    }

    expect(approvalPayload(req).reason).toBe('Requested by the planner')
  })

  it('prefers the explicit reason over displayReason.en', () => {
    const req: ApprovalLike = {
      agent,
      toolName: 'write',
      reason: 'explicit',
      displayReason: { en: 'displayed' },
    }

    expect(approvalPayload(req).reason).toBe('explicit')
  })

  it('omits reason entirely (no undefined key) when neither source provides one', () => {
    const payload = approvalPayload({ agent, toolName: 'bash' })

    expect('reason' in payload).toBe(false)
    expect(Object.keys(payload).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'tool_name'])
  })

  it('uses the generic tool text when toolName is missing', () => {
    const payload = approvalPayload({ agent, reason: 'why not' })

    expect(payload.tool_name).toBe('未知工具')
    expect(payload.hook_event_name).toBe('ApprovalRequest')
  })

  it('treats an empty toolName as missing', () => {
    expect(approvalPayload({ agent, toolName: '' }).tool_name).toBe('未知工具')
  })

  it('degrades to an empty session id and process.cwd() when the request carries no agent', () => {
    expect(approvalPayload({ toolName: 'bash' })).toEqual({
      hook_event_name: 'ApprovalRequest',
      session_id: '',
      cwd: process.cwd(),
      tool_name: 'bash',
    })
  })

  it('ignores an empty displayReason.en', () => {
    const payload = approvalPayload({ agent, displayReason: { en: '' } })
    expect('reason' in payload).toBe(false)
  })
})

describe('questionPayload', () => {
  it('builds a UserQuestion payload from the first question', () => {
    expect(questionPayload(questions)).toEqual({
      hook_event_name: 'UserQuestion',
      session_id: 'sess_root_1',
      cwd: '/workspace/project',
      question: 'Deploy to production?',
    })
  })

  it('omits question entirely when the request has no questions', () => {
    const payload = questionPayload({ agent })

    expect('question' in payload).toBe(false)
    expect(Object.keys(payload).sort()).toEqual(['cwd', 'hook_event_name', 'session_id'])
  })

  it('omits question when the first question has no text', () => {
    expect('question' in questionPayload({ agent, questions: [{}] })).toBe(false)
  })

  it('degrades to an empty session id and process.cwd() without an agent', () => {
    expect(questionPayload({ questions: [{ question: 'Continue?' }] })).toEqual({
      hook_event_name: 'UserQuestion',
      session_id: '',
      cwd: process.cwd(),
      question: 'Continue?',
    })
  })
})

describe('stopPayload', () => {
  it('builds a Stop payload', () => {
    expect(stopPayload(agent)).toEqual({
      hook_event_name: 'Stop',
      session_id: 'sess_root_1',
      cwd: '/workspace/project',
    })
  })

  it('degrades to process.cwd() when the header has no cwd', () => {
    expect(stopPayload(agentWithoutCwd)).toEqual({
      hook_event_name: 'Stop',
      session_id: 'sess_no_cwd',
      cwd: process.cwd(),
    })
  })
})

describe('errorPayload', () => {
  it('builds a RunFailed payload from an Error instance', () => {
    expect(errorPayload(agent, new Error('tool exploded'))).toEqual({
      hook_event_name: 'RunFailed',
      session_id: 'sess_root_1',
      cwd: '/workspace/project',
      error: 'tool exploded',
    })
  })

  it('accepts a string error', () => {
    expect(errorPayload(agent, 'plain failure').error).toBe('plain failure')
  })

  it('stringifies non-Error values', () => {
    expect(errorPayload(agent, 42).error).toBe('42')
    expect(errorPayload(agent, undefined).error).toBe('undefined')
    expect(errorPayload(agent, null).error).toBe('null')
  })

  it('degrades to an empty session id and process.cwd() without an agent', () => {
    expect(errorPayload(undefined as unknown as AgentLike, new Error('boom'))).toEqual({
      hook_event_name: 'RunFailed',
      session_id: '',
      cwd: process.cwd(),
      error: 'boom',
    })
  })

  it('truncates a long message to 200 characters', () => {
    const payload = errorPayload(agent, new Error('x'.repeat(500)))

    expect(payload.error).toHaveLength(200)
    expect(payload.error).toBe('x'.repeat(200))
  })

  it('truncates by code points, never splitting a surrogate pair', () => {
    const payload = errorPayload(agent, new Error('🔥'.repeat(500)))
    const chars = Array.from(payload.error ?? '')

    expect(chars).toHaveLength(200)
    expect(chars.every((char) => char === '🔥')).toBe(true)
  })

  it('never throws when the error value cannot be stringified', () => {
    const hostile = {
      toString(): string {
        throw new Error('toString is broken')
      },
    }

    expect(errorPayload(agent, hostile).error).toBe('未知错误')
    expect(errorPayload(agent, Object.create(null)).error).toBe('未知错误')
  })

  it('keeps the message untouched when it is exactly at the limit', () => {
    const payload = errorPayload(agent, new Error('y'.repeat(200)))
    expect(payload.error).toHaveLength(200)
  })
})

describe('event discriminator', () => {
  it('only ever emits the five contracted hook_event_name values', () => {
    const names = [
      sessionStartPayload(agent).hook_event_name,
      approvalPayload({ agent, toolName: 'bash' }).hook_event_name,
      questionPayload(questions).hook_event_name,
      stopPayload(agent).hook_event_name,
      errorPayload(agent, new Error('x')).hook_event_name,
    ]

    expect(names).toEqual(['SessionStart', 'ApprovalRequest', 'UserQuestion', 'Stop', 'RunFailed'])
  })

  it('never assigns an explicit undefined to an optional field', () => {
    const minimals = [
      sessionStartPayload(agent),
      approvalPayload({ agent }),
      questionPayload({ agent }),
      stopPayload(agent),
      errorPayload(agent, undefined),
    ]

    for (const payload of minimals) {
      for (const [key, value] of Object.entries(payload)) {
        expect(value, `${payload.hook_event_name}.${key}`).not.toBeUndefined()
      }
    }
  })
})
