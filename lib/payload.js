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
/**
 * Placeholder tool name for an approval request that carries no `toolName`.
 *
 * The Go side renders the tool name into the notification body verbatim
 * (`工具: <tool_name>` in `internal/claudehooks/event.go`), so an empty value
 * would produce a broken body. The wording follows the existing zh-CN fallbacks
 * in that package (`未知错误` / `操作失败`); this is the only display string this
 * module owns — everything else is data.
 */
const GENERIC_TOOL_NAME = '未知工具';
/** Last-resort failure text when an error value cannot be stringified at all. */
const GENERIC_ERROR_MESSAGE = '未知错误';
/**
 * Maximum length of a normalized error message, in Unicode code points.
 *
 * Matches `common.TruncateRunes(msg, 200)` on the Go side (issue #33), so both
 * halves of the boundary cut on the same unit instead of splitting a surrogate
 * pair.
 */
const ERROR_MESSAGE_LIMIT = 200;
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
export function sessionRef(agent) {
    const header = agent?.session?.header;
    const id = header?.id;
    const cwd = header?.cwd;
    return {
        // An empty id is the same as a missing one: the Go side keys focus state by
        // session id and would rather see "" than a placeholder it cannot match.
        session_id: typeof id === 'string' ? id : '',
        cwd: nonEmpty(cwd) ?? process.cwd(),
    };
}
/**
 * Build the `SessionStart` payload used for click-to-focus capture.
 *
 * The Go side intercepts this event and never notifies on it.
 *
 * @param agent - the newly created root agent.
 */
export function sessionStartPayload(agent) {
    return {
        hook_event_name: 'SessionStart',
        ...sessionRef(agent),
    };
}
/**
 * Build the `ApprovalRequest` payload for a pending tool approval.
 *
 * `reason` prefers the asker's own wording and falls back to the English entry
 * of `displayReason`; when neither exists the field is omitted entirely so the
 * Go decoder's zero value applies.
 *
 * @param req - the `approval/request` event.
 */
export function approvalPayload(req) {
    const payload = {
        hook_event_name: 'ApprovalRequest',
        ...sessionRef(req?.agent),
        tool_name: nonEmpty(req?.toolName) ?? GENERIC_TOOL_NAME,
    };
    const reason = nonEmpty(req?.reason) ?? nonEmpty(req?.displayReason?.['en']);
    if (reason !== undefined)
        payload.reason = reason;
    return payload;
}
/**
 * Build the `UserQuestion` payload for a pending question.
 *
 * Only the first question is reported; an event with no questions omits the
 * field rather than inventing text.
 *
 * @param request - the `user-questions/request` event.
 */
export function questionPayload(request) {
    const payload = {
        hook_event_name: 'UserQuestion',
        ...sessionRef(request?.agent),
    };
    const question = nonEmpty(request?.questions?.[0]?.question);
    if (question !== undefined)
        payload.question = question;
    return payload;
}
/**
 * Build the `Stop` payload for a finished turn.
 *
 * @param agent - the agent whose turn stopped.
 */
export function stopPayload(agent) {
    return {
        hook_event_name: 'Stop',
        ...sessionRef(agent),
    };
}
/**
 * Build the `RunFailed` payload for a failed turn.
 *
 * @param agent - the agent that failed.
 * @param error - anything thrown by DSH; normalized to a bounded string.
 */
export function errorPayload(agent, error) {
    return {
        hook_event_name: 'RunFailed',
        ...sessionRef(agent),
        error: normalizeError(error),
    };
}
/**
 * Normalize an arbitrary thrown value into a bounded, non-throwing string.
 *
 * `Error` instances contribute their `message`; everything else goes through
 * `String()`. Values whose `toString`/`Symbol.toPrimitive` throws (or that have
 * no prototype at all) fall back to a generic message.
 *
 * @param error - the value DSH reported.
 * @returns at most {@link ERROR_MESSAGE_LIMIT} code points.
 */
function normalizeError(error) {
    try {
        const message = error instanceof Error ? error.message : String(error);
        return truncate(typeof message === 'string' ? message : String(message), ERROR_MESSAGE_LIMIT);
    }
    catch {
        return GENERIC_ERROR_MESSAGE;
    }
}
/**
 * Return the value when it is a non-empty string, otherwise `undefined`.
 *
 * Used so optional payload fields can stay absent instead of being assigned an
 * explicit `undefined` (the Go decoder treats absent and empty alike, but a
 * stable key set keeps the JSON line predictable).
 */
function nonEmpty(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
/**
 * Truncate to a number of Unicode code points, never splitting a surrogate pair.
 *
 * @param text - the string to bound.
 * @param limit - maximum code points to keep.
 */
function truncate(text, limit) {
    const chars = Array.from(text);
    return chars.length <= limit ? text : chars.slice(0, limit).join('');
}
