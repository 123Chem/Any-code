import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { api, type Session } from '@/lib/api';
import { usePromptExecution } from './usePromptExecution';

vi.mock('@/lib/api', () => ({ api: {
  executeClaudeCode: vi.fn(), resumeClaudeCode: vi.fn(), recordPromptSent: vi.fn(),
  resolveClaudeProjectIdentity: vi.fn(),
} }));
vi.mock('@/lib/translationMiddleware', () => ({
  translationMiddleware: { isEnabled: async () => false },
  isSlashCommand: (value: string) => value.trim().startsWith('/'),
}));

const FIRST = '00000000-0000-0000-0000-000000000001';

function fixture(): Parameters<typeof usePromptExecution>[0] {
  return {
    projectPath: 'D:/one', isLoading: false, claudeSessionId: null, effectiveSession: null,
    isPlanMode: false, lastTranslationResult: null, isActive: false, isFirstPrompt: true,
    extractedSessionInfo: null, executionEngine: 'claude', claudeFastMode: false,
    hasActiveSessionRef: { current: false }, unlistenRefs: { current: [] },
    isMountedRef: { current: true }, isListeningRef: { current: true }, queuedPromptsRef: { current: [] },
    setIsLoading: vi.fn(), setError: vi.fn(), setMessages: vi.fn(), setClaudeSessionId: vi.fn(),
    setLastTranslationResult: vi.fn(), setQueuedPrompts: vi.fn(), setRawJsonlOutput: vi.fn(),
    setExtractedSessionInfo: vi.fn(), setIsFirstPrompt: vi.fn(), processMessageWithTranslation: vi.fn(),
  };
}

describe('Claude effort forwarding across prompt execution paths', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.executeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.resumeClaudeCode).mockResolvedValue(undefined);
    vi.mocked(api.recordPromptSent).mockResolvedValue(0);
    vi.mocked(api.resolveClaudeProjectIdentity).mockResolvedValue(`claude-project-${'a'.repeat(64)}`);
  });

  it('forwards the new tab Max choice along with its own tab ID', async () => {
    const { result } = renderHook(() => usePromptExecution(fixture()));
    await act(async () => { await result.current.handleSendPrompt('offline new', 'opus', undefined, 'max'); });
    expect(api.executeClaudeCode).toHaveBeenCalledWith('D:/one', 'offline new', 'opus', false,
      undefined, expect.stringMatching(/^[0-9a-f-]{36}$/i), false, 'max');
    expect(api.resumeClaudeCode).not.toHaveBeenCalled();
  });

  it('forwards effort while resuming the original session UUID', async () => {
    const config = fixture();
    config.effectiveSession = { id: FIRST, project_id: 'logical-one', project_path: 'D:/one',
      created_at: 1, engine: 'claude' } as Session;
    config.isFirstPrompt = false;
    const { result } = renderHook(() => usePromptExecution(config));
    await act(async () => { await result.current.handleSendPrompt('offline resume', 'opus', undefined, 'xhigh'); });
    expect(api.resumeClaudeCode).toHaveBeenCalledWith('D:/one', FIRST, 'offline resume', 'opus', false,
      undefined, expect.any(String), false, 'xhigh');
    expect(api.executeClaudeCode).not.toHaveBeenCalled();
  });

  it('leaves automatic prompts without a new effort override so saved policy can apply', async () => {
    const { result } = renderHook(() => usePromptExecution(fixture()));
    await act(async () => { await result.current.handleSendPrompt('approved plan', 'default'); });
    expect(api.executeClaudeCode).toHaveBeenCalledWith('D:/one', 'approved plan', 'default', false,
      undefined, expect.any(String), false, undefined);
  });

  it('captures the submitting effort in the queue instead of losing it at completion', async () => {
    const config = fixture();
    config.isLoading = true;
    const { result } = renderHook(() => usePromptExecution(config));
    await act(async () => { await result.current.handleSendPrompt('queued offline', 'opus', 16000, 'max'); });
    const update = vi.mocked(config.setQueuedPrompts).mock.calls[0][0];
    const queued = typeof update === 'function' ? update([]) : update;
    expect(queued).toEqual([{ id: expect.any(String), prompt: 'queued offline', model: 'opus',
      maxThinkingTokens: 16000, claudeEffort: 'max' }]);
    expect(api.executeClaudeCode).not.toHaveBeenCalled();
  });

  it('preserves an explicit inherit choice in a queued prompt', async () => {
    const config = fixture();
    config.isLoading = true;
    const { result } = renderHook(() => usePromptExecution(config));
    await act(async () => { await result.current.handleSendPrompt('queued inherit', 'opus', undefined, null); });
    const update = vi.mocked(config.setQueuedPrompts).mock.calls[0][0];
    const queued = typeof update === 'function' ? update([]) : update;
    expect(queued[0].claudeEffort).toBeNull();
  });

  it('abandons a late Chinese project identity lookup after the selected project changes', async () => {
    let resolve!: (project: string) => void;
    vi.mocked(api.resolveClaudeProjectIdentity).mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const config = fixture();
    config.projectPath = 'D:/中文甲';
    const { result, rerender } = renderHook(({ path }) => usePromptExecution({ ...config, projectPath: path }),
      { initialProps: { path: 'D:/中文甲' } });
    let sending!: Promise<void>;
    act(() => { sending = result.current.handleSendPrompt('delayed offline', 'opus', undefined, 'max'); });
    rerender({ path: 'D:/中文乙' });
    await act(async () => { resolve(`claude-project-${'a'.repeat(64)}`); await sending; });
    expect(api.executeClaudeCode).not.toHaveBeenCalled();
    expect(config.setExtractedSessionInfo).not.toHaveBeenCalled();
  });

  it('uses the latest UUID after init when dispatching a queued prompt from an older completion listener', async () => {
    const handlers = new Map<string, Parameters<typeof listen>[1]>();
    vi.mocked(listen).mockImplementation(async (name, handler) => {
      handlers.set(name, handler);
      return vi.fn();
    });
    const config = fixture();
    config.isActive = true;
    config.isListeningRef.current = false;
    const { result, rerender } = renderHook(({ knownId, first }) => usePromptExecution({
      ...config, claudeSessionId: knownId, isFirstPrompt: first,
    }), { initialProps: { knownId: null as string | null, first: true } });
    await act(async () => { await result.current.handleSendPrompt('Warmup offline', 'opus', undefined, 'high'); });
    const tabId = vi.mocked(api.executeClaudeCode).mock.calls[0][5];
    await act(async () => {
      await handlers.get('claude-output')!({ event: 'claude-output', id: 1, payload: {
        tab_id: tabId, payload: JSON.stringify({ type: 'system', subtype: 'init', session_id: FIRST, cwd: 'D:/one' }),
      } });
    });
    expect(config.setExtractedSessionInfo).toHaveBeenCalledWith({ sessionId: FIRST,
      projectId: `claude-project-${'a'.repeat(64)}`, engine: 'claude' });
    config.queuedPromptsRef.current = [{ id: 'queued', prompt: 'queued offline', model: 'opus', claudeEffort: 'max' }];
    rerender({ knownId: FIRST, first: false });
    await act(async () => {
      await handlers.get('claude-complete')!({ event: 'claude-complete', id: 2,
        payload: { tab_id: tabId, session_id: FIRST, payload: true } });
    });
    await waitFor(() => expect(api.resumeClaudeCode).toHaveBeenCalledWith('D:/one', FIRST, 'queued offline', 'opus', false,
      undefined, tabId, false, 'max'));
    expect(api.executeClaudeCode).toHaveBeenCalledTimes(1);
  });
});
