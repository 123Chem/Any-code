import { renderHook } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeStreamMessage } from '@/types/claude';
import { resolveClaudeContext } from '@/lib/claudeContextWindow';
import { claudeConverter } from '@/lib/stream/converters/ClaudeConverter';
import { useContextWindowUsage } from './useContextWindowUsage';

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const FIRST = '00000000-0000-0000-0000-000000000001';
const SECOND = '00000000-0000-0000-0000-000000000002';

const init = (model = OPUS, session = FIRST): ClaudeStreamMessage => ({
  type: 'system', subtype: 'init', model, session_id: session,
});
const assistant = (tokens: number, model: string | null = OPUS, session = FIRST): ClaudeStreamMessage => ({
  type: 'assistant', session_id: session,
  message: { ...(model ? { model } : {}), usage: { input_tokens: tokens, output_tokens: 50000 } },
} as ClaudeStreamMessage);
const result = (modelUsage: Record<string, unknown>, session = FIRST): ClaudeStreamMessage => ({
  type: 'result', session_id: session, modelUsage, num_turns: 8, duration_ms: 1000,
  usage: { input_tokens: 1400000, output_tokens: 500000 },
});
const read = (messages: ClaudeStreamMessage[], model: string | undefined = OPUS, engine = 'claude') =>
  renderHook(() => useContextWindowUsage(messages, model, engine)).result.current;
const syntheticError = (): ClaudeStreamMessage => ({
  type: 'assistant', error: 'unknown',
  message: {
    role: 'assistant', model: '<synthetic>', stop_reason: 'stop_sequence',
    content: [{ type: 'text', text: 'API error' }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
} as ClaudeStreamMessage);

describe('Claude current context capacity and usage', () => {
  it('keeps a 600k snapshot for a custom model with a 1M name hint', () => {
    const usage = read([assistant(600000)], `${OPUS}[1M]`);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.hasData).toBe(true);
    expect(usage.currentTokens).toBe(600000);
    expect(usage.formattedPercentage).toBe('60.0%');
  });

  it('reads the native result model window before applying the snapshot overflow gate', () => {
    const usage = read([init(), assistant(600000), result({ [OPUS]: { contextWindow: 1000000 } })]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.hasData).toBe(true);
    expect(usage.currentTokens).toBe(600000);
    expect(usage.percentage).toBe(60);
  });

  it('retains a valid primary snapshot when a live synthetic API error arrives', () => {
    const initial = [init(), assistant(100000), result({ [OPUS]: { contextWindow: 1000000 } })];
    const error = claudeConverter.convert({ ...syntheticError(), session_id: FIRST, parent_tool_use_id: null });
    expect(error).not.toBeNull();
    const messages = [...initial, error!];
    const original = JSON.stringify(messages);
    const { result: hook, rerender } = renderHook(({ events }) => useContextWindowUsage(events, OPUS, 'claude'),
      { initialProps: { events: initial } });
    expect(hook.current.currentTokens).toBe(100000);
    expect(hook.current.hasData).toBe(true);
    rerender({ events: messages });
    expect(hook.current.hasData).toBe(true);
    expect(hook.current.currentTokens).toBe(100000);
    expect(hook.current.contextWindowSize).toBe(1000000);
    expect(hook.current.percentage).toBe(10);
    const scoped = resolveClaudeContext(messages, OPUS).messages;
    expect(scoped).toHaveLength(messages.length);
    scoped.forEach((message, index) => expect(message).toBe(messages[index]));
    expect(scoped.at(-1)?.error).toBe('unknown');
    expect(JSON.stringify(messages)).toBe(original);
  });

  it('retains the valid snapshot when reopening history with a synthetic API error', () => {
    const model = 'claude-opus-4-7';
    const snapshot = { ...assistant(100000, model), session_id: undefined, sessionId: FIRST, isSidechain: false };
    const error = { ...syntheticError(), sessionId: FIRST, isSidechain: false, isApiErrorMessage: true };
    const messages = [snapshot, error];
    const original = JSON.stringify(messages);
    const usage = read(messages, 'default');
    expect(usage.hasData).toBe(true);
    expect(usage.currentTokens).toBe(100000);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.percentage).toBe(10);
    const scoped = resolveClaudeContext(messages, 'default').messages;
    expect(scoped).toHaveLength(2);
    expect(scoped[0]).toBe(snapshot);
    expect(scoped[1]).toBe(error);
    expect(scoped[1].isApiErrorMessage).toBe(true);
    expect(scoped[1].message).toMatchObject({ model: '<synthetic>' });
    expect(JSON.stringify(messages)).toBe(original);
  });

  it('keeps cumulative result tokens out and retains the existing input plus cache formula', () => {
    const snapshot = assistant(580000);
    snapshot.message!.usage = { input_tokens: 580000, output_tokens: 500000,
      cache_creation_input_tokens: 10000, cache_read_input_tokens: 10000 } as NonNullable<ClaudeStreamMessage['message']>['usage'];
    const usage = read([init(), snapshot, result({ [OPUS]: { contextWindow: 1000000 } })]);
    expect(usage.currentTokens).toBe(600000);
    expect(usage.breakdown.outputTokens).toBe(500000);
    expect(usage.percentage).toBe(60);
  });

  it('matches the current primary model even when a different model did more work', () => {
    const usage = read([init(), assistant(600000), result({
      [SONNET]: { contextWindow: 2000000, inputTokens: 10000000 },
      [OPUS]: { contextWindow: 1000000, inputTokens: 600000 },
    })]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(600000);
  });

  it('ignores a result window belonging only to a different model', () => {
    const usage = read([init(), assistant(100000), result({ [SONNET]: { contextWindow: 4000000 } })]);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('lets a real smaller window override a static 1M model capacity', () => {
    const model = 'claude-opus-4-7';
    const usage = read([init(model), assistant(100000, model), result({ [model]: { contextWindow: 200000 } })], model);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.percentage).toBe(50);
  });

  it('uses valid modelUsage when a canonical capacity field on that result is invalid', () => {
    const completed = result({ [OPUS]: { contextWindow: 1000000 } });
    completed.context_window = { context_window_size: 0 };
    const usage = read([init(), assistant(600000), completed]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(600000);
  });

  it('uses the latest valid canonical window even when the name advertises 1M', () => {
    const model = 'claude-opus-4-7[1m]';
    const usage = read([init(model), assistant(100000, model), {
      type: 'system', model, session_id: FIRST, context_window: { context_window_size: 200000 },
    }], model);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.percentage).toBe(50);
  });

  it('resolves default and family selectors through the current main model', () => {
    const messages = [init(), assistant(600000), result({
      [SONNET]: { contextWindow: 2000000 }, [OPUS]: { contextWindow: 1000000 },
    })];
    expect(read(messages, 'default').contextWindowSize).toBe(1000000);
    expect(read(messages, 'opus[1m]').contextWindowSize).toBe(1000000);
  });

  it('prefers an exact 1M variant and refuses ambiguous compatible variants', () => {
    expect(read([init(), assistant(100000), result({
      [OPUS]: { contextWindow: 200000 }, [`${OPUS}[1m]`]: { contextWindow: 1000000 },
    })], `${OPUS}[1M]`).contextWindowSize).toBe(1000000);
    expect(read([init(), assistant(100000), result({
      [`${OPUS}[1m]`]: { contextWindow: 1000000 }, [`${OPUS}-1m`]: { contextWindow: 2000000 },
    })]).contextWindowSize).toBe(200000);
  });

  it('does not let a subagent replace primary capacity, even with the same model and session', () => {
    const child = { type: 'system', session_id: FIRST, model: OPUS, parent_tool_use_id: 'child-task',
      context_window_size: 4000000 } as ClaudeStreamMessage;
    const childResult = result({ [OPUS]: { contextWindow: 4000000 } });
    childResult.parent_tool_use_id = 'child-task';
    const usage = read([init(), assistant(100000), result({ [OPUS]: { contextWindow: 1000000 } }), child, childResult]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('does not carry capacity across a new init of the same native session', () => {
    const usage = read([init(), assistant(100000), result({ [OPUS]: { contextWindow: 1000000 } }), init(), assistant(100000)]);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('ignores old-session metadata arriving after the new session init', () => {
    const late = result({ [OPUS]: { contextWindow: 4000000 } });
    late.context_window_size = 4000000;
    const usage = read([init(), { type: 'system', session_id: FIRST, context_window_size: 3000000 },
      init(OPUS, SECOND), assistant(100000, OPUS, SECOND), late]);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('does not carry anonymous old capacity across a change of the main model', () => {
    const usage = read([init(), { type: 'system', context_window_size: 3000000 }, assistant(100000),
      result({ [OPUS]: { contextWindow: 1000000 } }), assistant(100000, SONNET)], SONNET);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('drops stale capacity after a selector switch without rewriting history', () => {
    const messages = [init(), assistant(600000), result({ [OPUS]: { contextWindow: 1000000 } })];
    const original = JSON.stringify(messages);
    const { result: hook, rerender } = renderHook(({ model }) => useContextWindowUsage(messages, model, 'claude'),
      { initialProps: { model: OPUS } });
    expect(hook.current.contextWindowSize).toBe(1000000);
    rerender({ model: SONNET });
    expect(hook.current.contextWindowSize).toBe(200000);
    expect(hook.current.hasData).toBe(false);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it.each([0, -1, NaN, Infinity, '1M', '1000000', {}, 100000000000000000])(
    'rejects illegal capacity %s without dropping an otherwise valid snapshot', (capacity) => {
      const completed = result({ [OPUS]: { contextWindow: capacity } });
      completed.context_window = { context_window_size: capacity };
      expect(read([init(), assistant(100000), completed]).contextWindowSize).toBe(200000);
    },
  );

  it('uses a sole reported model for an unknown default, but does not guess among several', () => {
    expect(read([assistant(100000, null), result({ [OPUS]: { contextWindow: 1000000 } })], 'default')
      .contextWindowSize).toBe(1000000);
    expect(read([assistant(100000, null), result({ [OPUS]: { contextWindow: 1000000 },
      [SONNET]: { contextWindow: 2000000 } })], 'default').contextWindowSize).toBe(200000);
  });

  it('reports capacity without fabricating occupancy from a result-only history', () => {
    const usage = read([result({ [OPUS]: { contextWindow: 1000000 } })]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(0);
    expect(usage.hasData).toBe(false);
  });

  it('keeps explicit current_usage priority and avoids summing turn snapshots', () => {
    const usage = read([init(), { type: 'system', session_id: FIRST, model: OPUS,
      context_window: { context_window_size: 1000000, current_usage: { input_tokens: 400000 } } },
    assistant(600000), result({ [OPUS]: { contextWindow: 1000000 } })]);
    expect(usage.currentTokens).toBe(400000);
    expect(usage.percentage).toBe(40);
  });

  it('does not send IPC or write native compaction settings when capacity crosses an estimate', () => {
    vi.mocked(invoke).mockClear();
    expect(read([init(), assistant(900000), result({ [OPUS]: { contextWindow: 1000000 } })])
      .currentTokens).toBe(900000);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('filters a same-model subagent usage snapshot together with its capacity', () => {
    const child = assistant(900000);
    child.parent_tool_use_id = 'child-task';
    const usage = read([init(), assistant(100000), result({ [OPUS]: { contextWindow: 1000000 } }), child]);
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('cannot adopt a late old-session current_usage through the corrected 1M gate', () => {
    const old = { type: 'system', session_id: FIRST, context_window: {
      context_window_size: 1000000, current_usage: { input_tokens: 700000 },
    } } as ClaudeStreamMessage;
    const usage = read([init(OPUS, SECOND), assistant(100000, OPUS, SECOND),
      result({ [OPUS]: { contextWindow: 1000000 } }, SECOND), old]);
    expect(usage.currentTokens).toBe(100000);
  });

  it('does not carry an explicit snapshot into a new init of the same session', () => {
    const old = { type: 'system', session_id: FIRST, context_window: {
      context_window_size: 1000000, current_usage: { input_tokens: 700000 },
    } } as ClaudeStreamMessage;
    const usage = read([init(), old, init(), assistant(100000), result({ [OPUS]: { contextWindow: 1000000 } })]);
    expect(usage.currentTokens).toBe(100000);
  });

  it('does not treat anonymous prior-model current_usage as a new-model snapshot', () => {
    const old = { type: 'system', context_window: { current_usage: { input_tokens: 700000 } } } as ClaudeStreamMessage;
    const usage = read([init(), assistant(100000), old, assistant(100000, SONNET),
      result({ [SONNET]: { contextWindow: 1000000 } })], SONNET);
    expect(usage.currentTokens).toBe(100000);
  });

  it('treats a default init name as unresolved rather than as a concrete model id', () => {
    const usage = read([init('default'), assistant(100000, null), result({ [OPUS]: { contextWindow: 1000000 } })], 'default');
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('uses a known actual model as the fallback for reopened default-model history', () => {
    const usage = read([assistant(600000, 'claude-opus-4-7')], 'default');
    expect(usage.contextWindowSize).toBe(1000000);
    expect(usage.currentTokens).toBe(600000);
  });

  it('uses an unknown actual model only through its matching runtime metadata', () => {
    const model = 'fixture-custom-model';
    const usage = read([init(model), assistant(100000, model), result({
      [model]: { contextWindow: 1000000 }, [OPUS]: { contextWindow: 4000000 },
    })], 'default');
    expect(usage.contextWindowSize).toBe(1000000);
    expect(read([assistant(100000, model)], 'default').contextWindowSize).toBe(200000);
  });

  it('keeps same-model alias init metadata associated with the concrete assistant model', () => {
    const model = 'claude-opus-4-7';
    const first = init('opus');
    first.context_window_size = 200000;
    const usage = read([first, assistant(100000, model)], 'opus');
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });

  it('resolves the best selector from its actually served primary model', () => {
    const usage = read([init(), assistant(100000), result({ [OPUS]: { contextWindow: 200000 } })], 'best');
    expect(usage.contextWindowSize).toBe(200000);
  });

  it('resolves opusplan capacity from the actual execution phase rather than the plan model', () => {
    const usage = read([init(SONNET), assistant(100000, SONNET), result({
      [SONNET]: { contextWindow: 200000 }, [OPUS]: { contextWindow: 1000000 },
    })], 'opusplan');
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.currentTokens).toBe(100000);
  });
});

describe('other engines keep their existing context snapshot rules', () => {
  it('keeps the Codex runtime window and filters cumulative thread usage', () => {
    const usage = read([{ type: 'system', usage: { input_tokens: 200000, output_tokens: 1000 },
      codexMetadata: { modelContextWindow: 2000000 } },
    { type: 'assistant', usage: { input_tokens: 20000000, output_tokens: 1000 },
      codexMetadata: { codexItemType: 'thread_token_usage_updated' } } ] as ClaudeStreamMessage[], 'gpt-5.5', 'codex');
    expect(usage.contextWindowSize).toBe(2000000);
    expect(usage.currentTokens).toBe(200000);
  });

  it('keeps Gemini result usage as a snapshot and ignores Claude modelUsage', () => {
    const usage = read([{ type: 'result', duration_ms: 1000, context_window_size: 2000000,
      usage: { input_tokens: 400000, output_tokens: 1000 }, modelUsage: { [OPUS]: { contextWindow: 9000000 } },
    }], 'gemini-2.5-pro', 'gemini');
    expect(usage.contextWindowSize).toBe(2000000);
    expect(usage.currentTokens).toBe(400000);
  });
});
