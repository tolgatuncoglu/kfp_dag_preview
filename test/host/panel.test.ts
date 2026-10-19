import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WebviewPanel } from 'vscode';
import { parsePipelineSpec } from '../../src/core/graph';
import { DagPanel } from '../../src/host/panel';

function harness() {
  const sent: unknown[] = [];
  let receive: (message: unknown) => void = () => {};
  let closed: () => void = () => {};
  const panel = {
    webview: {
      postMessage: async (message: unknown) => { sent.push(message); return true; },
      onDidReceiveMessage: (listener: (message: unknown) => void) => { receive = listener; return { dispose() {} }; },
    },
    onDidDispose: (listener: () => void) => { closed = listener; return { dispose() {} }; },
    dispose: vi.fn(),
    reveal: vi.fn(),
  } as unknown as WebviewPanel;
  const callbacks = {
    refresh: vi.fn(),
    copyMermaid: vi.fn(),
    collapse: vi.fn(),
    setDirection: vi.fn(),
    renderAnyway: vi.fn(),
    showOutput: vi.fn(),
    disposed: vi.fn(),
  };
  return { panel, sent, emit: (message: unknown) => receive(message), close: () => closed(), callbacks };
}

describe('DagPanel', () => {
  it('accepts only supported layout directions from the webview', () => {
    const h = harness();
    new DagPanel(h.panel, h.callbacks);
    for (const direction of ['TB', 'LR', 'RL', 'TD', null, 42, undefined]) {
      h.emit({ type: 'setDirection', direction });
    }
    expect(h.callbacks.setDirection.mock.calls).toEqual([['TB'], ['LR']]);
  });

  it('reveals the underlying panel', () => {
    const h = harness();
    new DagPanel(h.panel, h.callbacks).reveal();
    expect((h.panel as any).reveal).toHaveBeenCalled();
  });

  it('sends graph, loading, stale error, and large-graph warning states', () => {
    const h = harness();
    const view = new DagPanel(h.panel, h.callbacks);
    const graph = parsePipelineSpec(readFileSync(join(__dirname, '..', 'fixtures', 'simple.yaml'), 'utf8'));
    view.showLoading();
    view.showGraph(graph, 'flowchart LR\n  a["Hello"]\n', 'prior failure');
    view.showError('compile failed', true);
    view.showSizeWarning(501, 0);
    expect(h.sent.map((message: any) => message.type)).toEqual(['loading', 'graph', 'error', 'sizeWarning']);
    expect((h.sent[1] as any).graph.root.tasks[0].label).toBe('Hello');
    expect((h.sent[1] as any).staleError).toBe('prior failure');
    expect((h.sent[2] as any)).toMatchObject({ message: 'compile failed', stale: true });
  });

  it('routes recognized actions and ignores unknown messages', () => {
    const h = harness();
    new DagPanel(h.panel, h.callbacks);
    h.emit({ type: 'copyMermaid' });
    h.emit({ type: 'refresh' });
    h.emit({ type: 'collapse', scopeId: 'root/group' });
    h.emit({ type: 'renderAnyway' });
    h.emit({ type: 'showOutput' });
    h.emit({ type: 'executePython' });
    expect(h.callbacks.copyMermaid).toHaveBeenCalledTimes(1);
    expect(h.callbacks.refresh).toHaveBeenCalledTimes(1);
    expect(h.callbacks.collapse).toHaveBeenCalledWith('root/group');
    expect(h.callbacks.renderAnyway).toHaveBeenCalledTimes(1);
    expect(h.callbacks.showOutput).toHaveBeenCalledTimes(1);
  });

  it('reports panel closure to its owner', () => {
    const h = harness();
    new DagPanel(h.panel, h.callbacks);
    h.close();
    expect(h.callbacks.disposed).toHaveBeenCalledTimes(1);
  });

  it('waits for the webview script before starting compilation', async () => {
    const h = harness();
    const view = new DagPanel(h.panel, h.callbacks);
    let ready = false;
    void view.whenReady().then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    h.emit({ type: 'ready' });
    await Promise.resolve();
    expect(ready).toBe(true);
  });
});
