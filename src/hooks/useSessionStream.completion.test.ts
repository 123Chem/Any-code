import { useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import type { ClaudeStreamMessage } from '@/types/claude';
import { useSessionStream } from './useSessionStream';

vi.mock('@/lib/api', () => ({ api: {
  getClaudeSessionPolicy: vi.fn(), loadSessionHistory: vi.fn(),
} }));

const SESSION = '00000000-0000-4000-8000-000000000011';
const PROJECT = 'claude-project-' + 'a'.repeat(64);
type Handler = Parameters<typeof listen>[1];
let listeners: Map<string, Set<Handler>>;

function useHistoryConnection() {
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const isListeningRef = useRef(false);
  const hasActiveSessionRef = useRef(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const isMountedRef = useRef(true);
  const stream = useSessionStream({
    session: { id: SESSION, project_id: PROJECT, project_path: 'D:/offline', created_at: 1 },
    isMountedRef, isListeningRef, hasActiveSessionRef, unlistenRefs,
    setIsLoading, setMessages, setError: vi.fn(), setRawJsonlOutput: vi.fn(),
    setClaudeSessionId: vi.fn(), processMessageWithTranslation: async message => {
      setMessages(previous => [...previous, message]);
    },
  });
  return { ...stream, isLoading, messages, isListeningRef, unlistenRefs };
}

describe('reconnected Claude completion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    listeners = new Map();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      const callbacks = listeners.get(name) || new Set<Handler>();
      callbacks.add(handler);
      listeners.set(name, callbacks);
      return () => { callbacks.delete(handler); };
    });
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValue({
      schema: 1, session_id: SESSION, history_root: 'c:/offline', project_path: 'd:/offline',
      configured_percent: null, configured_effort: null,
      observation: { active: false, applied_percent: null, applied_effort: null,
        compaction_count: 0, current_tokens: null, last_error: null },
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('restores a persisted failure and clears a lost busy indicator on a reconnected history tab', async () => {
    const failure = { type: 'assistant' as const, session_id: SESSION,
      message: { content: [{ type: 'text' as const, text: '429 Service Unavailable' }] } };
    vi.mocked(api.loadSessionHistory).mockResolvedValue([failure]);
    const { result } = renderHook(() => useHistoryConnection());
    await act(async () => { await result.current.reconnectToSession(SESSION); });
    expect(result.current.isLoading).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(result.current.messages).toEqual([failure]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isListeningRef.current).toBe(false);
    expect(result.current.unlistenRefs.current).toHaveLength(0);
  });

  it('cleans partial subscriptions when a later registration fails', async () => {
    const register = vi.mocked(listen).getMockImplementation()!;
    let calls = 0;
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      if (++calls === 2) throw new Error('offline registration failed');
      return register(name, handler);
    });
    const { result } = renderHook(() => useHistoryConnection());
    await act(async () => { await result.current.reconnectToSession(SESSION); });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isListeningRef.current).toBe(false);
    expect(listeners.get(`claude-output:${SESSION}`)?.size).toBe(0);
    expect(result.current.unlistenRefs.current).toHaveLength(0);
  });

  it('does not revive a connection when completion fires during the final registration', async () => {
    const register = vi.mocked(listen).getMockImplementation()!;
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      const unlisten = await register(name, handler);
      if (name === `claude-complete:${SESSION}`) {
        handler({ event: name, id: 1, payload: false });
      }
      return unlisten;
    });
    const { result } = renderHook(() => useHistoryConnection());
    await act(async () => { await result.current.reconnectToSession(SESSION); });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isListeningRef.current).toBe(false);
    expect(result.current.unlistenRefs.current).toHaveLength(0);
  });
});
