import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import type { NativeSessionPolicy } from '@/types/nativeCompactPolicy';
import { useNativeSessionPolicy } from './useNativeSessionPolicy';

vi.mock('@/lib/api', () => ({ api: {
  getClaudeSessionPolicy: vi.fn(), setClaudeSessionPolicy: vi.fn(), setClaudeSessionEffort: vi.fn(),
} }));

const FIRST = '00000000-0000-0000-0000-000000000001';
const SECOND = '00000000-0000-0000-0000-000000000002';
const policy = (session = FIRST, project = 'd:/one'): NativeSessionPolicy => ({
  schema: 1, history_root: 'd:/history', session_id: session, project_path: project,
  configured_percent: null, configured_effort: null, observation: { active: false, applied_percent: null, applied_effort: null,
    compaction_count: 0, current_tokens: null, last_error: null },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('native policy session ownership and delayed responses', () => {
  let deliver: (value: NativeSessionPolicy) => void;
  let stop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    stop = vi.fn();
    vi.mocked(listen).mockImplementation(async (_name, handler) => {
      deliver = value => handler({ event: 'claude-native-policy', id: 1, payload: value });
      return stop;
    });
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValue(policy());
  });

  it('rejects a matching UUID from a different history root or project', async () => {
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(result.current.policy?.configured_percent).toBeNull());
    act(() => deliver({ ...policy(), history_root: 'd:/another', configured_percent: 60 }));
    act(() => deliver({ ...policy(), project_path: 'd:/another', configured_percent: 60 }));
    expect(result.current.policy?.history_root).toBe('d:/history');
    expect(result.current.policy?.configured_percent).toBeNull();
  });

  it('accepts a real native boundary observation for its established owner', async () => {
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(result.current.policy?.schema).toBe(1));
    const updated = policy();
    updated.observation.compaction_count = 1;
    updated.observation.current_tokens = 12000;
    act(() => deliver(updated));
    expect(result.current.policy?.observation.compaction_count).toBe(1);
    expect(result.current.policy?.observation.current_tokens).toBe(12000);
  });

  it('does not attach a delayed read to a newly selected session', async () => {
    const first = deferred<NativeSessionPolicy>();
    vi.mocked(api.getClaudeSessionPolicy).mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(policy(SECOND, 'd:/two'));
    const { result, rerender } = renderHook(({ id, project }) => useNativeSessionPolicy(id, project),
      { initialProps: { id: FIRST, project: 'D:/one' } });
    rerender({ id: SECOND, project: 'D:/two' });
    await waitFor(() => expect(result.current.policy?.session_id).toBe(SECOND));
    await act(async () => { first.resolve(policy()); await first.promise; });
    expect(result.current.policy?.session_id).toBe(SECOND);
  });

  it('does not attach a delayed save to a newly selected session', async () => {
    const saved = deferred<NativeSessionPolicy>();
    vi.mocked(api.setClaudeSessionPolicy).mockReturnValue(saved.promise);
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy(SECOND, 'd:/two'));
    const { result, rerender } = renderHook(({ id, project }) => useNativeSessionPolicy(id, project),
      { initialProps: { id: FIRST, project: 'D:/one' } });
    await waitFor(() => expect(result.current.policy?.session_id).toBe(FIRST));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(60); });
    rerender({ id: SECOND, project: 'D:/two' });
    await waitFor(() => expect(result.current.policy?.session_id).toBe(SECOND));
    await act(async () => { saved.resolve({ ...policy(), configured_percent: 60 }); await saving; });
    expect(result.current.policy?.session_id).toBe(SECOND);
    expect(result.current.saving).toBe(false);
  });

  it('does not overwrite a successful save with an older initial read', async () => {
    const initial = deferred<NativeSessionPolicy>();
    vi.mocked(api.getClaudeSessionPolicy).mockReturnValue(initial.promise);
    vi.mocked(api.setClaudeSessionPolicy).mockResolvedValue({ ...policy(), configured_percent: 60 });
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await act(async () => { await result.current.save(60); });
    await act(async () => { initial.resolve(policy()); await initial.promise; });
    expect(result.current.policy?.configured_percent).toBe(60);
  });

  it('releases a listener whose registration finishes after unmount', async () => {
    const registered = deferred<() => void>();
    vi.mocked(listen).mockReturnValue(registered.promise);
    const { unmount } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    unmount();
    await act(async () => { registered.resolve(stop); await registered.promise; });
    expect(stop).toHaveBeenCalledOnce();
  });

  it('retains a native start event that arrives before ownership lookup finishes', async () => {
    const initial = deferred<NativeSessionPolicy>();
    vi.mocked(api.getClaudeSessionPolicy).mockReturnValue(initial.promise);
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(deliver).toBeDefined());
    const started = policy();
    started.observation.active = true;
    act(() => deliver(started));
    await act(async () => { initial.resolve(policy()); await initial.promise; });
    expect(result.current.policy?.observation.active).toBe(true);
  });

  it('does not replace successful save state with an obsolete read error', async () => {
    const initial = deferred<NativeSessionPolicy>();
    vi.mocked(api.getClaudeSessionPolicy).mockReturnValue(initial.promise);
    vi.mocked(api.setClaudeSessionPolicy).mockResolvedValue({ ...policy(), configured_percent: 60 });
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await act(async () => { await result.current.save(60); });
    await act(async () => { initial.reject(new Error('obsolete read')); await initial.promise.catch(() => undefined); });
    expect(result.current.policy?.configured_percent).toBe(60);
    expect(result.current.error).toBeNull();
  });

  it('saves effort without writing a compaction percentage or global settings', async () => {
    vi.mocked(api.setClaudeSessionEffort).mockResolvedValue({ ...policy(), configured_effort: 'max', configured_percent: 60 });
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(result.current.policy?.session_id).toBe(FIRST));
    await act(async () => { expect(await result.current.saveEffort('max')).toBe(true); });
    expect(api.setClaudeSessionEffort).toHaveBeenCalledWith(FIRST, 'D:/one', 'max');
    expect(api.setClaudeSessionPolicy).not.toHaveBeenCalled();
    expect(result.current.policy?.configured_percent).toBe(60);
    expect(result.current.policy?.configured_effort).toBe('max');
  });

  it('keeps the running effort visible while the saved choice waits for the next worker', async () => {
    const current = policy();
    current.configured_effort = 'max';
    current.observation.active = true;
    current.observation.applied_effort = 'max';
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValue(current);
    vi.mocked(api.setClaudeSessionEffort).mockResolvedValue({ ...current, configured_effort: 'low' });
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(result.current.policy?.observation.active).toBe(true));
    await act(async () => { await result.current.saveEffort('low'); });
    expect(result.current.policy?.configured_effort).toBe('low');
    expect(result.current.policy?.observation.applied_effort).toBe('max');
  });

  it('does not attach a delayed effort save to a different selected project', async () => {
    const saved = deferred<NativeSessionPolicy>();
    vi.mocked(api.setClaudeSessionEffort).mockReturnValue(saved.promise);
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValueOnce(policy())
      .mockResolvedValueOnce(policy(SECOND, 'd:/two'));
    const { result, rerender } = renderHook(({ id, project }) => useNativeSessionPolicy(id, project),
      { initialProps: { id: FIRST, project: 'D:/one' } });
    await waitFor(() => expect(result.current.policy?.session_id).toBe(FIRST));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.saveEffort('max'); });
    rerender({ id: SECOND, project: 'D:/two' });
    await waitFor(() => expect(result.current.policy?.session_id).toBe(SECOND));
    await act(async () => { saved.resolve({ ...policy(), configured_effort: 'max' }); await saving; });
    expect(result.current.policy?.session_id).toBe(SECOND);
    expect(result.current.policy?.configured_effort).toBeNull();
  });

  it('preserves the selected value when an effort save fails', async () => {
    vi.mocked(api.setClaudeSessionEffort).mockRejectedValue(new Error('policy write locked'));
    const { result } = renderHook(() => useNativeSessionPolicy(FIRST, 'D:/one'));
    await waitFor(() => expect(result.current.policy?.session_id).toBe(FIRST));
    await act(async () => { expect(await result.current.saveEffort('max')).toBe(false); });
    expect(result.current.policy?.configured_effort).toBeNull();
    expect(result.current.error).toContain('policy write locked');
    expect(result.current.saving).toBe(false);
  });
});
