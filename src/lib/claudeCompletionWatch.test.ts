import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeSessionPolicy } from '@/types/nativeCompactPolicy';
import { sameClaudeProjectPath, watchClaudeCompletion } from './claudeCompletionWatch';

const SESSION = '00000000-0000-4000-8000-000000000011';
const policy = (active: boolean): NativeSessionPolicy => ({
  schema: 1, history_root: 'c:/offline', session_id: SESSION, project_path: 'd:/offline',
  configured_percent: null, configured_effort: null,
  observation: { active, applied_percent: null, applied_effort: null,
    compaction_count: 0, current_tokens: null, last_error: null },
});

describe('native completion reconciliation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('normalizes Windows aliases without merging distinct case-sensitive Unix projects', () => {
    expect(sameClaudeProjectPath('D:\\offline\\', '\\\\?\\d:\\offline')).toBe(true);
    expect(sameClaudeProjectPath('\\\\?\\UNC\\host\\share', '//HOST/share')).toBe(true);
    expect(sameClaudeProjectPath('/work/One', '/work/one')).toBe(false);
    expect(sameClaudeProjectPath(undefined, undefined)).toBe(false);
  });

  it('restores a missed terminal event only after two matching inactive observations', async () => {
    const onEnded = vi.fn(async () => {});
    const stop = watchClaudeCompletion({ sessionId: SESSION, projectPath: 'D:\\offline',
      isCurrent: () => true, readPolicy: vi.fn(async () => policy(false)), onEnded });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onEnded).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onEnded).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(onEnded).toHaveBeenCalledTimes(1);
    stop();
  });

  it('does not impose a timeout on a live worker, including a long native retry', async () => {
    const onEnded = vi.fn(async () => {});
    const stop = watchClaudeCompletion({ sessionId: SESSION, projectPath: 'D:/offline',
      isCurrent: () => true, readPolicy: vi.fn(async () => policy(true)), onEnded });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(onEnded).not.toHaveBeenCalled();
    stop();
  });

  it('does not conclude completion from an unavailable status, another UUID or another project', async () => {
    const onEnded = vi.fn(async () => {});
    const readPolicy = vi.fn<() => Promise<NativeSessionPolicy>>()
      .mockRejectedValueOnce(new Error('offline status unavailable'))
      .mockResolvedValueOnce({ ...policy(false), session_id: '00000000-0000-4000-8000-000000000012' })
      .mockResolvedValue({ ...policy(false), project_path: 'd:/other' });
    const stop = watchClaudeCompletion({ sessionId: SESSION, projectPath: 'D:/offline',
      isCurrent: () => true, readPolicy, onEnded });
    await vi.advanceTimersByTimeAsync(30000);
    expect(onEnded).not.toHaveBeenCalled();
    stop();
  });

  it('discards a late status read after cancellation or a different send has started', async () => {
    let resolve!: (value: NativeSessionPolicy) => void;
    let current = true;
    const onEnded = vi.fn(async () => {});
    const readPolicy = vi.fn<() => Promise<NativeSessionPolicy>>()
      .mockResolvedValueOnce(policy(false))
      .mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const stop = watchClaudeCompletion({ sessionId: SESSION, projectPath: 'D:/offline',
      isCurrent: () => current, readPolicy, onEnded });
    await vi.advanceTimersByTimeAsync(10000);
    current = false;
    resolve(policy(false));
    await vi.advanceTimersByTimeAsync(20000);
    expect(onEnded).not.toHaveBeenCalled();
    expect(readPolicy).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never overlaps status reads and cancels the timer when disposed', async () => {
    let resolve!: (value: NativeSessionPolicy) => void;
    const readPolicy = vi.fn<() => Promise<NativeSessionPolicy>>()
      .mockReturnValue(new Promise(done => { resolve = done; }));
    const stop = watchClaudeCompletion({ sessionId: SESSION, projectPath: 'D:/offline',
      isCurrent: () => true, readPolicy, onEnded: vi.fn(async () => {}) });
    await vi.advanceTimersByTimeAsync(30000);
    expect(readPolicy).toHaveBeenCalledTimes(1);
    stop();
    resolve(policy(false));
    await vi.advanceTimersByTimeAsync(30000);
    expect(readPolicy).toHaveBeenCalledTimes(1);
  });
});
