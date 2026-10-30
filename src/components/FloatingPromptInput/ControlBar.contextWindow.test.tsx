import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useContextWindowUsage } from '@/hooks/useContextWindowUsage';
import type { ClaudeStreamMessage } from '@/types/claude';
import { ControlBar } from './ControlBar';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ExecutionEngineSelector', () => ({ ExecutionEngineSelector: () => null }));
vi.mock('./ModelSelector', () => ({ ModelSelector: () => null }));
vi.mock('./ThinkingModeToggle', () => ({ ThinkingModeToggle: () => null }));
vi.mock('./PlanModeToggle', () => ({ PlanModeToggle: () => null }));
vi.mock('@/components/SessionToolbar', () => ({ SessionToolbar: () => null }));
vi.mock('@/components/widgets/ContextWindowIndicator', () => ({
  ContextWindowIndicator: ({ model, messages, engine }: { model?: string; messages: ClaudeStreamMessage[]; engine?: string }) => {
    const usage = useContextWindowUsage(messages, model, engine);
    return <span data-testid="context" data-model={model}
      data-window={usage.contextWindowSize} data-tokens={usage.currentTokens} />;
  },
}));

const MODEL = 'claude-opus-5-5';
const SESSION = '00000000-0000-0000-0000-000000000001';
const messages = (window: number): ClaudeStreamMessage[] => [
  { type: 'system', subtype: 'init', session_id: SESSION, model: MODEL },
  { type: 'assistant', session_id: SESSION, message: { model: MODEL,
    usage: { input_tokens: 100000, output_tokens: 1000 } } } as ClaudeStreamMessage,
  { type: 'result', session_id: SESSION, num_turns: 1,
    usage: { input_tokens: 100000, output_tokens: 1000 }, modelUsage: { [MODEL]: { contextWindow: window } } },
];

function props(fast: boolean, window = 1000000) {
  return {
    isLoading: false, prompt: '', executionEngineConfig: { engine: 'claude' as const, claudeFastMode: fast },
    setExecutionEngineConfig: vi.fn(), selectedModel: 'custom' as const, setSelectedModel: vi.fn(),
    availableModels: [{ id: 'custom' as const, name: `${MODEL}[1M]`, description: 'fixture model', icon: null }],
    selectedThinkingMode: '', handleToggleThinkingMode: vi.fn(), hasMessages: true,
    showCostPopover: false, setShowCostPopover: vi.fn(), isEnhancing: false,
    enableProjectContext: false, setEnableProjectContext: vi.fn(), enableDualAPI: false,
    setEnableDualAPI: vi.fn(), getEnabledProviders: () => [], handleEnhancePromptWithAPI: vi.fn(),
    onCancel: vi.fn(), onSend: vi.fn(), messages: messages(window),
  };
}

describe('ControlBar uses the actual Fast model for context display', () => {
  it('uses the native Opus alias in Fast mode and matches the current 5.5 runtime capacity', () => {
    const input = props(true);
    render(<ControlBar {...input} />);
    expect(screen.getByTestId('context')).toHaveAttribute('data-model', 'opus');
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '1000000');
    expect(screen.getByTestId('context')).toHaveAttribute('data-tokens', '100000');
    expect(input.setExecutionEngineConfig).not.toHaveBeenCalled();
    expect(input.setSelectedModel).not.toHaveBeenCalled();
    expect(input.onSend).not.toHaveBeenCalled();
  });

  it('keeps the selected model when Fast is off', () => {
    render(<ControlBar {...props(false)} />);
    expect(screen.getByTestId('context')).toHaveAttribute('data-model', `${MODEL}[1M]`);
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '1000000');
  });

  it('uses a real smaller Fast capacity rather than the static Opus default', () => {
    render(<ControlBar {...props(true, 200000)} />);
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '200000');
    expect(screen.getByTestId('context')).toHaveAttribute('data-tokens', '100000');
  });

  it('refreshes the display when a custom name changes without changing the selector id', () => {
    const input = props(false);
    const original = JSON.stringify(input.messages);
    const { rerender } = render(<ControlBar {...input} />);
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '1000000');
    rerender(<ControlBar {...input} availableModels={[{ ...input.availableModels[0], name: 'fixture-next-model' }]} />);
    expect(screen.getByTestId('context')).toHaveAttribute('data-model', 'fixture-next-model');
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '200000');
    expect(JSON.stringify(input.messages)).toBe(original);
    expect(input.setSelectedModel).not.toHaveBeenCalled();
    expect(input.onSend).not.toHaveBeenCalled();
  });

  it('keeps a missing custom name unresolved while respecting actual runtime metadata', () => {
    render(<ControlBar {...props(false)} availableModels={[]} />);
    expect(screen.getByTestId('context')).not.toHaveAttribute('data-model');
    expect(screen.getByTestId('context')).toHaveAttribute('data-window', '1000000');
  });
});
