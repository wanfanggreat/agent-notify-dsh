/**
 * Event -> payload construction.
 *
 * Every export here is a pure function: same input, same output, no IO and no
 * throwing. Fields that are missing at runtime degrade to documented
 * placeholders (docs/CONTRACT.md §1, §6.1) because a notification must never
 * disturb the agent it reports on.
 *
 * Dependency direction (docs/CONTRACT.md §3): this module may only import
 * `types.ts`; it must never import `spawn.ts` or `listeners.ts`.
 * @module agent-notify-dsh/payload
 */
import type { DshHookPayload } from './types.js';
/**
 * Minimal agent projection needed to build a payload.
 *
 * Deliberately structural instead of importing `dsh-agent`'s full `Agent`, so
 * this module stays dependency-free and tests can pass plain objects.
 */
export interface AgentLike {
    readonly session: {
        readonly header: {
            readonly id: string;
            readonly cwd?: string;
        };
    };
}
/** Projection of a `approval/request` event. */
export interface ApprovalLike {
    readonly agent?: AgentLike;
    readonly toolName?: string;
    readonly reason?: string;
    readonly displayReason?: Readonly<Record<string, string>>;
}
/** Projection of a `user-questions/request` event. */
export interface QuestionLike {
    readonly agent?: AgentLike;
    readonly questions?: ReadonlyArray<{
        readonly question?: string;
    }>;
}
/**
 * Extract the addressing fields shared by every event.
 *
 * Degrades instead of throwing when the projection is empty or malformed:
 * `session_id` becomes `''` and `cwd` falls back to `process.cwd()`, which is
 * what the Go side treats as "no workspace" and "unknown workspace".
 *
 * @param agent - the event's agent, when the event carries one.
 * @returns the session id and working directory to address the notification.
 */
export declare function sessionRef(agent: AgentLike | undefined): {
    session_id: string;
    cwd: string;
};
/**
 * Build the `SessionStart` payload used for click-to-focus capture.
 *
 * The Go side intercepts this event and never notifies on it.
 *
 * @param agent - the newly created root agent.
 */
export declare function sessionStartPayload(agent: AgentLike): DshHookPayload;
/**
 * Build the `ApprovalRequest` payload for a pending tool approval.
 *
 * `reason` prefers the asker's own wording and falls back to the English entry
 * of `displayReason`; when neither exists the field is omitted entirely so the
 * Go decoder's zero value applies.
 *
 * @param req - the `approval/request` event.
 */
export declare function approvalPayload(req: ApprovalLike): DshHookPayload;
/**
 * Build the `UserQuestion` payload for a pending question.
 *
 * Only the first question is reported; an event with no questions omits the
 * field rather than inventing text.
 *
 * @param request - the `user-questions/request` event.
 */
export declare function questionPayload(request: QuestionLike): DshHookPayload;
/**
 * Build the `Stop` payload for a finished turn.
 *
 * @param agent - the agent whose turn stopped.
 */
export declare function stopPayload(agent: AgentLike): DshHookPayload;
/**
 * Build the `RunFailed` payload for a failed turn.
 *
 * @param agent - the agent that failed.
 * @param error - anything thrown by DSH; normalized to a bounded string.
 */
export declare function errorPayload(agent: AgentLike, error: unknown): DshHookPayload;
