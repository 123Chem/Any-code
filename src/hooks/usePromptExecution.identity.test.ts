import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import { usePromptExecution } from './usePromptExecution';

vi.mock('@/lib/api', () => ({ api: {
  executeClaudeCode: vi.fn(), resumeClaudeCode: vi.fn(), recordPromptSent: vi.fn(),
  markPromptCompleted: vi.fn(), resolveClaudeProjectIdentity: vi.fn(),
} }));
vi.mock('@/lib/translationMiddleware', () => ({
  translationMiddleware: { isEnabled: async () => false },
  isSlashCommand: (value: string) => value.trim().startsWith('/'),
}));

const FIRST = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
let listeners: Map<string, Set<Parameters<typeof listen>[1]>>;

function fixture(sessionId?: string): Parameters<typeof usePromptExecution>[0] {
  return {
    projectPath: 'D:/same', isLoading: false, claudeSessionId: sessionId || null,
    effectiveSession: sessionId ? { id: sessionId, project_id: 'logical-same',
      project_path: 'D:/same', created_at: 1, engine: 'claude' } : null,
    isPlanMode: false, lastTranslationResult: null, isActive: true, isFirstPrompt: !sessionId,
    extractedSessionInfo: null, executionEngine: 'claude', claudeFastMode: false,
    hasActiveSessionRef: { current: false }, unlistenRefs: { current: [] },
    isMountedRef: { current: true }, isListeningRef: { current: false }, queuedPromptsRef: { current: [] },
    setIsLoading: vi.fn(), setError: vi.fn(), setMessages: vi.fn(), setClaudeSessionId: vi.fn(),
    setLastTranslationResult: vi.fn(), setQueuedPrompts: vi.fn(), setRawJsonlOutput: vi.fn(),
    setExtractedSessionInfo: vi.fn(), setIsFirstPrompt: vi.fn(), processMessageWithTranslation: vi.fn(async () => {}),
  };
}

async function deliver(name: string, payload: unknown) {
  await act(async () => {
    await Promise.all([...(listeners.get(name) || [])]
      .map(handler => handler({ event: name, id: 1, payload })));
  });
}

async function bootTwo(firstId?: string, secondId?: string) {
  const first = fixture(firstId);
  const second = fixture(secondId);
  const firstHook = renderHook(() => usePromptExecution(first));
  const secondHook = renderHook(() => usePromptExecution(second));
  await act(async () => {
    await firstHook.result.current.handleSendPrompt('Warmup offline first', 'opus');
    await secondHook.result.current.handleSendPrompt('Warmup offline second', 'opus');
  });
  vi.mocked(first.setError).mockClear();
  vi.mocked(second.setError).mockClear();
  vi.mocked(first.setIsLoading).mockClear();
  vi.mocked(second.setIsLoading).mockClear();
  return { first, second };
}

describe('Claude global events require a tab or an established UUID owner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listeners = new Map();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      const callbacks = listeners.get(name) || new Set<Parameters<typeof listen>[1]>();
      callbacks.add(handler);
      listeners.set(name, callbacks);
      return () => { callbacks.delete(handler); };
    });
    vi.mocked(api.executeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.resumeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.recordPromptSent).mockResolvedValue(0);
    vi.mocked(api.markPromptCompleted).mockResolvedValue(undefined);
    vi.mocked(api.resolveClaudeProjectIdentity).mockResolvedValue('claude-project-' + 'a'.repeat(64));
  });

  it('does not broadcast unidentified errors or a bare cancellation completion to two waiting tabs', async () => {
    const { first, second } = await bootTwo();
    await deliver('claude-error', 'unidentified exit code: 1');
    await deliver('claude-error', { tab_id: null, payload: 'unidentified stderr' });
    await deliver('claude-complete', false);
    expect(first.setError).not.toHaveBeenCalled();
    expect(second.setError).not.toHaveBeenCalled();
    expect(first.hasActiveSessionRef.current).toBe(true);
    expect(second.hasActiveSessionRef.current).toBe(true);
    expect(first.setIsLoading).not.toHaveBeenCalledWith(false);
    expect(second.setIsLoading).not.toHaveBeenCalledWith(false);
  });

  it('routes a tabless manual worker error and completion only to its established UUID', async () => {
    const { first, second } = await bootTwo(FIRST, SECOND);
    await deliver('claude-error', { tab_id: null, session_id: FIRST, payload: 'owned stderr' });
    expect(first.setError).toHaveBeenCalledWith('owned stderr');
    expect(second.setError).not.toHaveBeenCalled();
    await deliver('claude-complete', { tab_id: null, session_id: FIRST, payload: false });
    expect(first.hasActiveSessionRef.current).toBe(false);
    expect(second.hasActiveSessionRef.current).toBe(true);
    expect(second.setIsLoading).not.toHaveBeenCalledWith(false);
  });

  it('does not bind two new tabs to a tabless init even when the cwd matches', async () => {
    const { first, second } = await bootTwo();
    await deliver('claude-output', { tab_id: null, session_id: FIRST,
      payload: JSON.stringify({ type: 'system', subtype: 'init', session_id: FIRST, cwd: 'D:/same' }) });
    expect(first.setClaudeSessionId).not.toHaveBeenCalled();
    expect(second.setClaudeSessionId).not.toHaveBeenCalled();
    expect(first.processMessageWithTranslation).not.toHaveBeenCalled();
    expect(second.processMessageWithTranslation).not.toHaveBeenCalled();
  });

  it('retains a real new session init for its own explicit tab ID', async () => {
    const { first, second } = await bootTwo();
    const tabId = vi.mocked(api.executeClaudeCode).mock.calls[0][5];
    await deliver('claude-output', { tab_id: tabId, session_id: FIRST,
      payload: JSON.stringify({ type: 'system', subtype: 'init', session_id: FIRST, cwd: 'D:/same' }) });
    expect(first.setClaudeSessionId).toHaveBeenCalledWith(FIRST);
    expect(first.processMessageWithTranslation).toHaveBeenCalledTimes(1);
    expect(second.setClaudeSessionId).not.toHaveBeenCalled();
    expect(second.processMessageWithTranslation).not.toHaveBeenCalled();
  });

  it('retains legacy raw output only when its embedded UUID matches an established session', async () => {
    const { first, second } = await bootTwo(FIRST, SECOND);
    await deliver('claude-output', JSON.stringify({ type: 'assistant', session_id: FIRST,
      message: { content: [{ type: 'text', text: 'owned output' }] } }));
    expect(first.processMessageWithTranslation).toHaveBeenCalledTimes(1);
    expect(second.processMessageWithTranslation).not.toHaveBeenCalled();
  });

  it('rejects contradictory UUID metadata even on the matching tab', async () => {
    const { first, second } = await bootTwo(FIRST, SECOND);
    const tabId = vi.mocked(api.resumeClaudeCode).mock.calls[0][6];
    await deliver('claude-error', { tab_id: tabId, session_id: SECOND, payload: 'contradictory owner' });
    expect(first.setError).not.toHaveBeenCalled();
    expect(second.setError).not.toHaveBeenCalled();
  });
});
