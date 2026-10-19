import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  trusted: true,
  errors: [] as string[],
  choices: [] as string[],
  picked: 'Enter function name…',
  panel: undefined as any,
  panels: [] as any[],
  panelDisposals: 0,
  saveDisposals: 0,
  created: 0,
  reveals: 0,
  watchers: [] as any[],
  copied: '',
  saveListener: undefined as undefined | ((d: any) => void),
}));

vi.mock('../../src/host/panel', () => ({
  createDagPanel: (_uri: unknown, callbacks: any) => {
    state.created++;
    state.panel = {
      callbacks,
      reveal() { state.reveals++; },
      whenReady: async () => {},
      showLoading() {}, showGraph: vi.fn(), showError() {}, showSizeWarning() {},
      dispose: vi.fn(() => { state.panelDisposals++; callbacks.disposed(); }),
    };
    state.panels.push(state.panel);
    return state.panel;
  },
}));

vi.mock('../../src/host/environment', () => ({
  resolveKfpExecutable: vi.fn(async () => '/usr/bin/kfp'),
}));

vi.mock('../../src/host/compiler', () => ({
  compilePipeline: vi.fn(async () => 'root:\n  dag:\n    tasks:\n      hello: {taskInfo: {name: Hello}}\n'),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (name: string, handler: (...args: any[]) => unknown) => {
      state.handlers.set(name, handler);
      return { dispose() {} };
    },
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showErrorMessage: async (message: string) => { state.errors.push(message); },
    showQuickPick: async (choices: string[]) => { state.choices = choices; return state.picked; },
    showInputBox: async () => 'manual_pipeline',
    activeTextEditor: undefined,
  },
  workspace: {
    get isTrusted() { return state.trusted; },
    onDidSaveTextDocument: (listener: (d: any) => void) => { state.saveListener = listener; return { dispose() { state.saveDisposals++; } }; },
    getWorkspaceFolder: () => ({ uri: { path: '/work', toString: () => 'file:///work' } }),
    createFileSystemWatcher: (pattern: any) => {
      const w: any = { pattern, handlers: {} as any, dispose: vi.fn() };
      for (const n of ['Change', 'Create', 'Delete']) w[`onDid${n}`] = (h: any) => { w.handlers[n] = h; return { dispose() {} }; };
      state.watchers.push(w);
      return w;
    },
    getConfiguration: () => ({ get: () => undefined }),
    openTextDocument: async () => ({ getText: () => 'root:\n  dag:\n    tasks:\n      hello: {taskInfo: {name: Hello}}\n' }),
  },
  Uri: { joinPath: (base: any, ...parts: string[]) => ({ path: '/work' + parts.join('/').replace(/^\.\./, ''), toString: () => 'file:///work' }) },
  RelativePattern: class { constructor(public base: any, public pattern: string) {} },
  env: { clipboard: { writeText: async (text: string) => { state.copied = text; } } },
}));

import { compilePipeline } from '../../src/host/compiler';
import { activate, selectPipeline } from '../../src/host/extension';

beforeEach(() => {
  state.handlers.clear();
  state.errors.length = 0;
  state.trusted = true;
  state.choices = [];
  state.panelDisposals = 0;
  state.saveDisposals = 0;
  state.created = 0;
  state.reveals = 0;
  state.panels.length = 0;
  state.watchers.length = 0;
  vi.mocked(compilePipeline).mockReset();
  vi.mocked(compilePipeline).mockResolvedValue('root:\n  dag:\n    tasks:\n      hello: {taskInfo: {name: Hello}}\n');
});

const yamlUri = { scheme: 'file', fsPath: '/work/pipeline.yaml', path: '/work/pipeline.yaml', toString: () => 'file:///work/pipeline.yaml' };
const pyUri = { scheme: 'file', fsPath: '/work/pipeline.py', path: '/work/pipeline.py', toString: () => 'file:///work/pipeline.py' };

describe('extension activation', () => {
  it.each(['previewPython', 'previewYaml'])('wires layout and Copy Mermaid for %s without another compile', async (command) => {
    activate({ subscriptions: [] } as any);
    await state.handlers.get(`kfpDagPreview.${command}`)!(command === 'previewPython' ? pyUri : yamlUri, 'demo');
    const compiles = vi.mocked(compilePipeline).mock.calls.length;
    state.panel.callbacks.setDirection('TB');
    expect(state.panel.showGraph).toHaveBeenLastCalledWith(expect.anything(), expect.stringMatching(/^flowchart TB\n/), undefined);
    state.panel.callbacks.copyMermaid();
    expect(state.copied).toMatch(/^flowchart TB\n/);
    expect(vi.mocked(compilePipeline)).toHaveBeenCalledTimes(compiles);
  });

  it('registers Python and compiled YAML preview commands', () => {
    activate({ subscriptions: [] } as any);
    expect([...state.handlers.keys()]).toEqual([
      'kfpDagPreview.previewPython',
      'kfpDagPreview.previewYaml',
    ]);
  });

  it('refuses Python compilation in an untrusted workspace', async () => {
    state.trusted = false;
    activate({ subscriptions: [] } as any);
    await state.handlers.get('kfpDagPreview.previewPython')!({ scheme: 'file', fsPath: '/work/pipeline.py' });
    expect(state.errors[0]).toContain('trusted workspace');
  });

  it('offers manual function entry even when one pipeline name is detected', async () => {
    const chosen = await selectPipeline('from kfp import dsl\n@dsl.pipeline\ndef known(): pass\n@my_wrapper.pipeline\ndef other(): pass\n');
    expect(state.choices).toEqual(['known', 'Enter function name…']);
    expect(chosen).toBe('manual_pipeline');
  });

  it('disposes open preview panels and save listeners when the extension deactivates', async () => {
    const context = { subscriptions: [] as { dispose(): void }[] };
    activate(context as any);
    await state.handlers.get('kfpDagPreview.previewYaml')!(yamlUri);
    expect(state.saveDisposals).toBe(0);
    context.subscriptions.forEach((subscription) => subscription.dispose());
    expect(state.panelDisposals).toBe(1);
    expect(state.saveDisposals).toBe(1);
  });

  it('disposes every panel and watcher and aborts active compiles when three previews are open', async () => {
    const context = { subscriptions: [] as { dispose(): void }[] };
    activate(context as any);
    await state.handlers.get('kfpDagPreview.previewYaml')!(yamlUri);
    const activeSignals: AbortSignal[] = [];
    vi.mocked(compilePipeline).mockImplementation((input) => {
      const signal = input.signal!;
      activeSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    });
    const runPython = state.handlers.get('kfpDagPreview.previewPython')!;
    const pending = [runPython(pyUri, 'first'), runPython(pyUri, 'second')];
    await vi.waitFor(() => expect(activeSignals).toHaveLength(2));
    expect(state.panels).toHaveLength(3);
    expect(state.watchers).toHaveLength(3);
    context.subscriptions.forEach((subscription) => subscription.dispose());
    expect(state.panels.map((panel) => panel.dispose.mock.calls.length)).toEqual([1, 1, 1]);
    expect(state.watchers.map((watcher) => watcher.dispose.mock.calls.length)).toEqual([1, 1, 1]);
    expect(state.saveDisposals).toBe(3);
    expect(activeSignals.map((signal) => signal.aborted)).toEqual([true, true]);
    await Promise.all(pending);
  });

  it('does not trust-gate the YAML preview', async () => {
    state.trusted = false;
    activate({ subscriptions: [] } as any);
    await state.handlers.get('kfpDagPreview.previewYaml')!(yamlUri);
    expect(state.errors).toEqual([]);
    expect(state.created).toBe(1);
  });

  it('reveals the existing panel instead of opening a duplicate, and forgets disposed panels', async () => {
    const context = { subscriptions: [] as { dispose(): void }[] };
    activate(context as any);
    const run = state.handlers.get('kfpDagPreview.previewYaml')!;
    await run(yamlUri);
    await run(yamlUri);
    expect(state.created).toBe(1);
    expect(state.reveals).toBe(1);
    state.panel.dispose();
    await run(yamlUri);
    expect(state.created).toBe(2);
  });

  it('ignores the context object editor-title menus pass as the second argument', async () => {
    activate({ subscriptions: [] } as any);
    await state.handlers.get('kfpDagPreview.previewPython')!(pyUri, { groupId: 1 });
    expect(vi.mocked(compilePipeline).mock.calls.at(-1)![0].functionName).toBe('manual_pipeline');
  });

  it('dedupes Python previews per function name', async () => {
    activate({ subscriptions: [] } as any);
    const run = state.handlers.get('kfpDagPreview.previewPython')!;
    state.panel = undefined;
    await run(pyUri, 'a');
    await run(pyUri, 'a');
    await run(pyUri, 'b');
    expect(state.created).toBe(2);
    expect(state.reveals).toBe(1);
  });

  it('watches workspace .py files for Python previews, ignoring dependency dirs, and just the file for YAML', async () => {
    activate({ subscriptions: [] } as any);
    await state.handlers.get('kfpDagPreview.previewPython')!(pyUri, 'a');
    expect(state.watchers[0].pattern.pattern).toBe('**/*.py');
    await state.handlers.get('kfpDagPreview.previewYaml')!(yamlUri);
    expect(state.watchers[1].pattern.pattern).toBe('*');
    const { isIgnoredPath } = await import('../../src/host/changes');
    expect(isIgnoredPath('/work/.venv/lib/x.py')).toBe(true);
    expect(isIgnoredPath('/work/a/__pycache__/x.py')).toBe(true);
    expect(isIgnoredPath('/work/venv_tools/x.py')).toBe(false);
    expect(isIgnoredPath('/work/pkg/util.py')).toBe(false);
  });
});
