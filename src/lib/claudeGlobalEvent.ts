/** Global Claude events need an explicit tab or an already established UUID owner. */
export type ClaudeGlobalEventPayload<T> = {
  tab_id?: string | null;
  session_id?: string | null;
  payload: T;
} | T;

export interface NormalizedClaudeGlobalEvent<T> {
  tabId: string | null;
  sessionId: string | null;
  payload: T;
}

export function normalizeClaudeGlobalPayload<T>(payload: ClaudeGlobalEventPayload<T>): NormalizedClaudeGlobalEvent<T> {
  if (payload && typeof payload === 'object' && 'payload' in payload) {
    const envelope = payload as { tab_id?: unknown; session_id?: unknown; payload: T };
    return {
      tabId: typeof envelope.tab_id === 'string' ? envelope.tab_id : null,
      sessionId: typeof envelope.session_id === 'string' ? envelope.session_id : null,
      payload: envelope.payload,
    };
  }
  return { tabId: null, sessionId: null, payload: payload as T };
}

function normalizedSessionId(value?: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

export function ownsClaudeGlobalEvent(
  event: NormalizedClaudeGlobalEvent<unknown>, tabId: string,
  boundSessionId?: string | null, embeddedSessionId?: string | null,
): boolean {
  const declared = normalizedSessionId(event.sessionId);
  const embedded = normalizedSessionId(embeddedSessionId);
  if ((event.sessionId && !declared) || (embeddedSessionId && !embedded)) return false;
  if (declared && embedded && declared !== embedded) return false;
  const origin = declared || embedded;
  const bound = normalizedSessionId(boundSessionId);
  if (event.tabId) {
    if (event.tabId !== tabId) return false;
    return !bound || !origin || origin === bound;
  }
  // Cwd alone cannot bind a new tab, and an unidentified error cannot have an owner.
  return !!bound && origin === bound;
}
