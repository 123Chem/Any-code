import { describe, expect, it } from 'vitest';
import { getContextWindowSize } from './tokenCounter';

describe('Claude capacity name hints', () => {
  it.each(['claude-opus-5-5[1m]', 'claude-opus-5-5[1M]', 'custom-model[1m]',
    'CUSTOM-MODEL[1M]', ' custom-model[1m] ', 'custom-model-1m'])(
    'recognizes the explicit 1M suffix on %s without a model-specific table entry', (model) => {
      expect(getContextWindowSize(model, 'claude')).toBe(1000000);
    },
  );

  it.each(['custom-model', 'custom-1million', 'custom[1m]-preview', 'custom[11m]', 'custom[1mb]'])(
    'does not infer a 1M capacity from an unrelated name %s', (model) => {
      expect(getContextWindowSize(model, 'claude')).toBe(200000);
    },
  );

  it('preserves known capacities, aliases, and other engine defaults', () => {
    expect(getContextWindowSize('CLAUDE-OPUS-4-6', 'claude')).toBe(200000);
    expect(getContextWindowSize('CLAUDE-OPUS-4-7', 'claude')).toBe(1000000);
    expect(getContextWindowSize(' OPUS[1M] ', 'claude')).toBe(1000000);
    expect(getContextWindowSize('gpt-5.5', 'codex')).toBe(1050000);
    expect(getContextWindowSize('gemini-2.5-pro', 'gemini')).toBe(1000000);
  });
});
