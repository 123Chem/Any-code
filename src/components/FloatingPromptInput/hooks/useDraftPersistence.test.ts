import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftPersistence } from './useDraftPersistence';

describe('draft ownership and recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('does not automatically give the legacy draft to new project tabs', () => {
    localStorage.setItem('prompt_draft_global', 'old unassigned text');
    const restoreA = vi.fn();
    const restoreB = vi.fn();
    renderHook(() => useDraftPersistence({ draftScope: 'tab-a', onRestore: restoreA }));
    renderHook(() => useDraftPersistence({ draftScope: 'tab-b', onRestore: restoreB }));
    expect(restoreA).toHaveBeenLastCalledWith('');
    expect(restoreB).toHaveBeenLastCalledWith('');
    expect(localStorage.getItem('prompt_draft_global')).toBe('old unassigned text');
  });

  it('keeps two tabs without a UUID independent', () => {
    const a = renderHook(() => useDraftPersistence({ draftScope: 'tab-a' }));
    const b = renderHook(() => useDraftPersistence({ draftScope: 'tab-b' }));
    act(() => {
      a.result.current.saveDraft('project A');
      b.result.current.saveDraft('project B');
      vi.advanceTimersByTime(300);
    });
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBe('project A');
    expect(localStorage.getItem('prompt_draft_tab_tab-b')).toBe('project B');
    expect(localStorage.getItem('prompt_draft_global')).toBeNull();
  });

  it('flushes pending text to its old owner when the scope changes', () => {
    const restore = vi.fn();
    const hook = renderHook(({ scope }) => useDraftPersistence({
      draftScope: scope, onRestore: restore,
    }), { initialProps: { scope: 'tab-a' } });
    act(() => hook.result.current.saveDraft('pending A'));
    hook.rerender({ scope: 'tab-b' });
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBe('pending A');
    expect(restore).toHaveBeenLastCalledWith('');
    act(() => vi.advanceTimersByTime(300));
    expect(localStorage.getItem('prompt_draft_tab_tab-b')).toBeNull();
  });

  it('binds only the owning tab draft when the original UUID arrives', () => {
    localStorage.setItem('prompt_draft_tab_tab-b', 'unrelated B');
    const restore = vi.fn();
    const hook = renderHook(({ sessionId }: { sessionId?: string }) => useDraftPersistence({
      sessionId, draftScope: 'tab-a', onRestore: restore,
    }), { initialProps: { sessionId: undefined as string | undefined } });
    act(() => hook.result.current.saveDraft('pending A'));
    hook.rerender({ sessionId: 'original-uuid-a' });
    expect(localStorage.getItem('prompt_draft_original-uuid-a')).toBe('pending A');
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBeNull();
    expect(localStorage.getItem('prompt_draft_tab_tab-b')).toBe('unrelated B');
    expect(restore).toHaveBeenLastCalledWith('pending A');
  });

  it('preserves an existing UUID draft when an unrelated pending draft exists', () => {
    localStorage.setItem('prompt_draft_original-uuid-a', 'existing original draft');
    localStorage.setItem('prompt_draft_tab_tab-a', 'retained pending draft');
    const restore = vi.fn();
    renderHook(() => useDraftPersistence({
      sessionId: 'original-uuid-a', draftScope: 'tab-a', onRestore: restore,
    }));
    expect(restore).toHaveBeenLastCalledWith('existing original draft');
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBe('retained pending draft');
  });

  it('flushes the latest typing when the component closes before debounce', () => {
    const hook = renderHook(() => useDraftPersistence({ draftScope: 'tab-a' }));
    act(() => hook.result.current.saveDraft('latest typing'));
    hook.unmount();
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBe('latest typing');
  });

  it('lets the user explicitly recover the unassigned draft into only one tab', () => {
    localStorage.setItem('prompt_draft_global', 'old unassigned text');
    const a = renderHook(() => useDraftPersistence({ draftScope: 'tab-a' }));
    const b = renderHook(() => useDraftPersistence({ draftScope: 'tab-b' }));
    act(() => expect(a.result.current.restoreLegacyDraft()).toBe(true));
    expect(b.result.current.hasLegacyDraft).toBe(false);
    act(() => expect(b.result.current.restoreLegacyDraft()).toBe(false));
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBe('old unassigned text');
    expect(localStorage.getItem('prompt_draft_tab_tab-b')).toBeNull();
    expect(localStorage.getItem('prompt_draft_global')).toBe('old unassigned text');
  });

  it('clears a sent draft without a pending timer recreating it', () => {
    localStorage.setItem('prompt_draft_global', 'retained legacy copy');
    const hook = renderHook(() => useDraftPersistence({ draftScope: 'tab-a' }));
    act(() => {
      hook.result.current.saveDraft('sent text');
      hook.result.current.clearDraft();
      vi.advanceTimersByTime(300);
    });
    expect(localStorage.getItem('prompt_draft_tab_tab-a')).toBeNull();
    expect(localStorage.getItem('prompt_draft_global')).toBe('retained legacy copy');
  });
});
