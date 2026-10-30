import { useRef, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import type { ClaudeStreamMessage } from '@/types/claude';
import { usePromptExecution } from './usePromptExecution';

vi.mock('@/lib/api', () => ({ api: {
  executeClaudeCode: vi.fn(), resumeClaudeCode: vi.fn(), recordPromptSent: vi.fn(),
  markPromptCompleted: vi.fn(), resolveClaudeProjectIdentity: vi.fn(),
  listRunningClaudeSessions: vi.fn(), loadSessionHistory: vi.fn(),
  getClaudeSessionPolicy: vi.fn(),
} }));
vi.mock('@/lib/translationMiddleware', () => ({
  translationMiddleware: { isEnabled: async () => false },
  isSlashCommand: (value: string) => value.trim().startsWith('/'),
}));

const SESSION = '00000000-0000-4000-8000-000000000011';
const PROJECT = 'claude-project-' + 'a'.repeat(64);
type Handler = Parameters<typeof listen>[1];
let listeners: Map<string, Set<Handler>>;

function useConversation(active = true) {
  const [isLoading, setIsLoading] = useState(false);
  const [claudeSessionId, setClaudeSessionId] = useState<string | null>(null);
  const [isFirstPrompt, setIsFirstPrompt] = useState(true);
  const [messages, setMessages] = useState<ClaudeStreamMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [extractedSessionInfo, setExtractedSessionInfo] = useState<{
    sessionId: string; projectId: string; engine?: 'claude' | 'codex' | 'gemini';
  } | null>(null);
  const hasActiveSessionRef = useRef(false);
  const isListeningRef = useRef(false);
  const unlistenRefs = useRef<UnlistenFn[]>([]);
  const queuedPromptsRef = useRef([]);
  const isMountedRef = useRef(true);
  const execution = usePromptExecution({
    projectPath: 'D:/offline', isLoading, claudeSessionId, isFirstPrompt,
    effectiveSession: extractedSessionInfo ? { id: extractedSessionInfo.sessionId,
      project_id: PROJECT, project_path: 'D:/offline', created_at: 1, engine: 'claude' } : null,
    isPlanMode: false, lastTranslationResult: null, isActive: active,
    extractedSessionInfo, executionEngine: 'claude', hasActiveSessionRef,
    isListeningRef, unlistenRefs, queuedPromptsRef, isMountedRef,
    setIsLoading, setClaudeSessionId, setIsFirstPrompt, setMessages, setError,
    setExtractedSessionInfo, setLastTranslationResult: vi.fn(), setQueuedPrompts: vi.fn(),
    setRawJsonlOutput: vi.fn(), processMessageWithTranslation: async message => {
      setMessages(previous => [...previous, message]);
    },
  });
  return { ...execution, isLoading, claudeSessionId, messages, error,
    hasActiveSessionRef, isListeningRef, unlistenRefs };
}

async function emit(name: string, payload: unknown) {
  await Promise.all([...(listeners.get(name) || [])]
    .map(handler => handler({ event: name, id: 1, payload })));
}

function tabId() {
  const resumes = vi.mocked(api.resumeClaudeCode).mock.calls;
  return resumes.length ? resumes.at(-1)![6] : vi.mocked(api.executeClaudeCode).mock.calls.at(-1)![5];
}

async function nativeOutput(message: Record<string, unknown>) {
  const payload = JSON.stringify({ session_id: SESSION, ...message });
  await emit(`claude-output:${SESSION}`, payload);
  await emit('claude-output', { tab_id: tabId(), session_id: SESSION, payload });
}

async function nativeComplete(success: boolean) {
  await emit(`claude-complete:${SESSION}`, success);
  await emit('claude-complete', { tab_id: tabId(), session_id: SESSION, payload: success });
}

describe('Claude send lifecycle keeps terminal results observable', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listeners = new Map();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      const callbacks = listeners.get(name) || new Set<Handler>();
      callbacks.add(handler);
      listeners.set(name, callbacks);
      return () => { callbacks.delete(handler); };
    });
    vi.mocked(api.resolveClaudeProjectIdentity).mockResolvedValue(PROJECT);
    vi.mocked(api.executeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.resumeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.recordPromptSent).mockResolvedValue(0);
    vi.mocked(api.markPromptCompleted).mockResolvedValue(undefined);
    vi.mocked(api.listRunningClaudeSessions).mockResolvedValue([]);
    vi.mocked(api.loadSessionHistory).mockResolvedValue([]);
  });

  it('finishes two consecutive failed turns while retaining the original UUID', async () => {
    const { result } = renderHook(() => useConversation());
    for (let turn = 0; turn < 2; turn++) {
      await act(async () => { await result.current.handleSendPrompt('Warmup offline', 'opus'); });
      await act(async () => {
        await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' });
        await nativeOutput({ type: 'result', is_error: true, result: '429 Service Unavailable', duration_ms: 170000 + turn });
        await nativeComplete(false);
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.claudeSessionId).toBe(SESSION);
    }
    expect(api.executeClaudeCode).toHaveBeenCalledTimes(1);
    expect(api.resumeClaudeCode).toHaveBeenCalledTimes(1);
    expect(result.current.messages.filter(message => message.type === 'result')).toHaveLength(2);
  });

  it('keeps output and completion listeners for a queued turn in a background tab', async () => {
    const { result } = renderHook(() => useConversation(false));
    await act(async () => { await result.current.handleSendPrompt('Warmup offline background', 'opus'); });
    await act(async () => {
      await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' });
      await nativeOutput({ type: 'result', is_error: true, result: '429 Service Unavailable' });
      await nativeComplete(false);
    });
    expect(result.current.messages.some(message => message.type === 'result')).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('rebuilds listeners after a failed listener registration instead of leaving a stale listening flag', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('offline listener registration failed'));
    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.handleSendPrompt('Warmup first attempt', 'opus'); });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isListeningRef.current).toBe(false);
    await act(async () => { await result.current.handleSendPrompt('Warmup retry', 'opus'); });
    await act(async () => {
      await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' });
      await nativeComplete(false);
    });
    expect(result.current.isLoading).toBe(false);
  });

  it('does not start a worker after cancellation while project identity is being resolved', async () => {
    let resolve!: (value: string) => void;
    vi.mocked(api.resolveClaudeProjectIdentity).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const { result } = renderHook(() => useConversation());
    let sending!: Promise<void>;
    act(() => { sending = result.current.handleSendPrompt('Warmup cancelled', 'opus'); });
    result.current.hasActiveSessionRef.current = false;
    await act(async () => { resolve(PROJECT); await sending; });
    expect(api.executeClaudeCode).not.toHaveBeenCalled();
  });

  it('releases the busy indicator even if optional prompt recording has not returned', async () => {
    let resolveRecording!: (index: number) => void;
    vi.mocked(api.recordPromptSent).mockReturnValueOnce(new Promise(done => { resolveRecording = done; }));
    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.handleSendPrompt('offline prompt', 'opus'); });
    await act(async () => { await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' }); });
    await waitFor(() => expect(api.recordPromptSent).toHaveBeenCalled());
    act(() => {
      void nativeOutput({ type: 'result', is_error: true, result: '429 Service Unavailable' });
      void nativeComplete(false);
    });
    try {
      await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 350 });
    } finally {
      await act(async () => { resolveRecording(0); });
    }
  });

  it('reloads the original persisted failure when native completion events are missing', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValue({
      schema: 1, session_id: SESSION, history_root: 'c:/offline', project_path: 'd:/offline',
      configured_percent: null, configured_effort: null,
      observation: { active: false, applied_percent: null, applied_effort: null,
        compaction_count: 0, current_tokens: null, last_error: null },
    });
    const storedResult = { type: 'assistant' as const, session_id: SESSION,
      message: { content: [{ type: 'text' as const, text: '429 Service Unavailable' }] } };
    vi.mocked(api.loadSessionHistory).mockResolvedValue([storedResult]);
    const { result, unmount } = renderHook(() => useConversation());
    try {
      await act(async () => { await result.current.handleSendPrompt('Warmup offline', 'opus'); });
      await act(async () => { await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.messages).toEqual([storedResult]);
      expect(api.loadSessionHistory).toHaveBeenCalledWith(SESSION, PROJECT, 'claude');
      expect(api.executeClaudeCode).toHaveBeenCalledTimes(1);
      expect(api.resumeClaudeCode).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('keeps owned output after init and ignores a late completion from an earlier turn', async () => {
    const { result } = renderHook(() => useConversation());
    await act(async () => { await result.current.handleSendPrompt('Warmup first', 'opus'); });
    const oldComplete = [...listeners.get('claude-complete')!][0];
    await act(async () => {
      await nativeOutput({ type: 'system', subtype: 'init', cwd: 'D:/offline' });
      await nativeOutput({ type: 'assistant', cwd: 'D:/offline/subdir',
        message: { content: [{ type: 'text', text: 'owned response' }] } });
      await nativeComplete(true);
    });
    expect(result.current.messages.some(message => message.type === 'assistant')).toBe(true);
    await act(async () => { await result.current.handleSendPrompt('Warmup next', 'opus'); });
    await act(async () => { await oldComplete({ event: 'claude-complete', id: 1,
      payload: { tab_id: tabId(), session_id: SESSION, payload: false } }); });
    expect(result.current.isLoading).toBe(true);
    await act(async () => { await nativeComplete(false); });
    expect(result.current.isLoading).toBe(false);
  });
});
