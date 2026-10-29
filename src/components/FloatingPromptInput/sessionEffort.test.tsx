import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEventHandler, KeyboardEventHandler } from 'react';
import type { NativeSessionPolicy } from '@/types/nativeCompactPolicy';
import type { ThinkingEffort } from './types';
import { api } from '@/lib/api';
import { FloatingPromptInput } from './index';

vi.mock('@/lib/api', () => ({ api: {
  getClaudeSettings: vi.fn(), getClaudeSessionPolicy: vi.fn(),
  setClaudeSessionEffort: vi.fn(), updateThinkingMode: vi.fn(),
} }));
vi.mock('@/lib/promptEnhancementService', () => ({ getEnabledProviders: () => [] }));
vi.mock('./hooks/useImageHandling', () => ({ useImageHandling: () => ({
  imageAttachments: [], embeddedImages: [], dragActive: false,
  handlePaste: vi.fn(), handleRemoveImageAttachment: vi.fn(), handleRemoveEmbeddedImage: vi.fn(),
  handleDrag: vi.fn(), handleDrop: vi.fn(), addImage: vi.fn(),
  setImageAttachments: vi.fn(), setEmbeddedImages: vi.fn(),
}) }));
vi.mock('./hooks/useFileSelection', () => ({ useFileSelection: () => ({
  showFilePicker: false, filePickerQuery: '', detectAtSymbol: vi.fn(), updateFilePickerQuery: vi.fn(),
  handleFileSelect: vi.fn(), handleFilePickerClose: vi.fn(), setShowFilePicker: vi.fn(), setFilePickerQuery: vi.fn(),
}) }));
vi.mock('./hooks/usePromptEnhancement', () => ({ usePromptEnhancement: () => ({
  isEnhancing: false, handleEnhancePromptWithAPI: vi.fn(), enableDualAPI: false, setEnableDualAPI: vi.fn(),
}) }));
vi.mock('./hooks/usePromptSuggestion', () => ({ usePromptSuggestion: () => ({
  suggestion: null, isLoading: false, acceptSuggestion: vi.fn(), dismissSuggestion: vi.fn(),
}) }));
vi.mock('./hooks/useDraftPersistence', () => ({ useDraftPersistence: () => ({
  saveDraft: vi.fn(), clearDraft: vi.fn(),
}) }));
vi.mock('./hooks/useSlashCommandMenu', () => ({ useSlashCommandMenu: () => ({
  isOpen: false, query: '', selectedIndex: 0, setSelectedIndex: vi.fn(),
  selectCommand: vi.fn(), closeMenu: vi.fn(), handleKeyDown: () => false,
}) }));
vi.mock('./hooks/useCustomSlashCommands', () => ({ useCustomSlashCommands: () => ({ customCommands: [] }) }));
vi.mock('./hooks/usePluginSlashCommands', () => ({ usePluginSlashCommands: () => ({ pluginCommands: [] }) }));
vi.mock('./ExpandedModal', () => ({ ExpandedModal: () => null }));
vi.mock('./AttachmentPreview', () => ({ AttachmentPreview: () => null }));
vi.mock('./InputArea', async () => {
  const ReactModule = await import('react');
  return { InputArea: ReactModule.forwardRef<HTMLTextAreaElement, {
    prompt: string; onTextChange: ChangeEventHandler<HTMLTextAreaElement>;
    onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  }>((props, ref) => <textarea aria-label="prompt" ref={ref} value={props.prompt}
    onChange={props.onTextChange} onKeyDown={props.onKeyDown} />) };
});
vi.mock('./ControlBar', () => ({ ControlBar: ({ selectedThinkingEffort, handleToggleThinkingMode, thinkingDisabled, onSend }: {
  selectedThinkingEffort?: ThinkingEffort; handleToggleThinkingMode: () => void;
  thinkingDisabled?: boolean; onSend: () => void;
}) => <>
  <button aria-label="effort" disabled={thinkingDisabled} onClick={handleToggleThinkingMode}>
    {selectedThinkingEffort || 'inherit'}
  </button>
  <button onClick={onSend}>send</button>
</> }));

const FIRST = '00000000-0000-0000-0000-000000000001';
function policy(id: string, effort: ThinkingEffort | null = null): NativeSessionPolicy {
  return { schema: 1, session_id: id, history_root: 'd:/history', project_path: 'd:/one',
    configured_percent: 60, configured_effort: effort, observation: { active: false,
      applied_percent: null, applied_effort: null, compaction_count: 0, current_tokens: null, last_error: null } };
}

describe('Claude effort ownership at the real input component', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    vi.mocked(api.getClaudeSettings).mockResolvedValue({ data: { env: { CLAUDE_CODE_EFFORT_LEVEL: 'xhigh' } } });
    vi.mocked(api.getClaudeSessionPolicy).mockResolvedValue(policy(FIRST, 'low'));
    vi.mocked(api.setClaudeSessionEffort).mockImplementation(async (id, _project, effort) => policy(id, effort));
  });

  it('keeps two new tabs independent even when their project and global default match', async () => {
    localStorage.setItem('thinking_effort', 'xhigh');
    const firstSend = vi.fn();
    const secondSend = vi.fn();
    render(<>
      <div data-testid="first"><FloatingPromptInput projectPath="D:/one" onSend={firstSend} /></div>
      <div data-testid="second"><FloatingPromptInput projectPath="D:/one" onSend={secondSend} /></div>
    </>);
    const first = within(screen.getByTestId('first'));
    const second = within(screen.getByTestId('second'));
    await waitFor(() => expect(api.getClaudeSettings).toHaveBeenCalledTimes(2));
    for (let count = 0; count < 3; count++) fireEvent.click(first.getByRole('button', { name: 'effort' }));
    expect(first.getByRole('button', { name: 'effort' })).toHaveTextContent('max');
    expect(second.getByRole('button', { name: 'effort' })).toHaveTextContent('inherit');
    fireEvent.change(first.getByRole('textbox'), { target: { value: 'first offline message' } });
    fireEvent.click(first.getByRole('button', { name: 'send' }));
    expect(firstSend).toHaveBeenCalledWith('first offline message', 'default', undefined, 'max');
    expect(secondSend).not.toHaveBeenCalled();
    expect(api.updateThinkingMode).not.toHaveBeenCalled();
    expect(api.setClaudeSessionEffort).not.toHaveBeenCalled();
    expect(localStorage.getItem('thinking_effort')).toBe('xhigh');
  });

  it('handles Tab only in the owning textarea and leaves other tabs unchanged', () => {
    render(<>
      <div data-testid="first"><FloatingPromptInput projectPath="D:/one" onSend={vi.fn()} /></div>
      <div data-testid="second"><FloatingPromptInput projectPath="D:/two" onSend={vi.fn()} /></div>
    </>);
    const first = within(screen.getByTestId('first'));
    const second = within(screen.getByTestId('second'));
    fireEvent.keyDown(first.getByRole('textbox'), { key: 'Tab' });
    expect(first.getByRole('button', { name: 'effort' })).toHaveTextContent('high');
    expect(second.getByRole('button', { name: 'effort' })).toHaveTextContent('inherit');
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(first.getByRole('button', { name: 'effort' })).toHaveTextContent('high');
    expect(second.getByRole('button', { name: 'effort' })).toHaveTextContent('inherit');
  });

  it('restores and saves the original UUID policy rather than the shared effort default', async () => {
    const send = vi.fn();
    render(<FloatingPromptInput projectPath="D:/one" sessionId={FIRST} onSend={send} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'effort' })).toHaveTextContent('low'));
    fireEvent.click(screen.getByRole('button', { name: 'effort' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'effort' })).toHaveTextContent('medium'));
    expect(api.setClaudeSessionEffort).toHaveBeenCalledWith(FIRST, 'D:/one', 'medium');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'resume offline message' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(send).toHaveBeenCalledWith('resume offline message', 'default', undefined, 'medium');
    expect(api.updateThinkingMode).not.toHaveBeenCalled();
  });

  it('does not clear an existing effort while the initial policy read is still pending', () => {
    vi.mocked(api.getClaudeSessionPolicy).mockReturnValue(new Promise(() => {}));
    const send = vi.fn();
    render(<FloatingPromptInput projectPath="D:/one" sessionId={FIRST} onSend={send} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'pending policy offline' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));
    expect(send).toHaveBeenCalledWith('pending policy offline', 'default', undefined, undefined);
  });
});
