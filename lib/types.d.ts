/**
 * Shared types for the agent-notify DSH plugin.
 *
 * This module is dependency-free by design: every other source module may
 * import it, and it imports nothing from them (see docs/CONTRACT.md §3).
 * @module agent-notify-dsh/types
 */
/**
 * The hook event discriminator written to the agent-notify binary's stdin.
 *
 * Names deliberately reuse the Claude Code dialect (`hook_event_name`) so the
 * Go-side parser in `internal/claudehooks/event.go` accepts them without a new
 * decoder. See docs/CONTRACT.md §1.
 */
export type DshHookEventName = 'SessionStart' | 'ApprovalRequest' | 'UserQuestion' | 'Stop' | 'RunFailed';
/**
 * One normalized event as it crosses the plugin -> binary boundary.
 *
 * Serialized as a single JSON line on stdin. Optional fields stay absent rather
 * than null so the Go decoder's zero values apply.
 */
export interface DshHookPayload {
    /** Event discriminator; drives the Go-side switch. */
    hook_event_name: DshHookEventName;
    /** DSH session id (`agent.session.header.id`). */
    session_id: string;
    /** Session working directory (`agent.session.header.cwd`). */
    cwd: string;
    /** Tool awaiting an approval decision (`ApprovalRequest` only). */
    tool_name?: string;
    /** Human-readable approval reason, when the asker supplied one. */
    reason?: string;
    /** First pending question's text (`UserQuestion` only). */
    question?: string;
    /** Normalized failure message (`RunFailed` only). */
    error?: string;
}
/**
 * The side-effecting seam the listeners write through.
 *
 * Injected rather than imported so tests can record deliveries without spawning
 * a process, and so no listener depends on the process-spawning module. An
 * implementation MUST return synchronously and MUST NOT throw: a notification
 * is never allowed to disturb the agent it reports on.
 */
export interface Forwarder {
    /**
     * Deliver one event. Never throws, never blocks, never returns a promise.
     * @param payload - the event to forward.
     */
    forward(payload: DshHookPayload): void;
}
