import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parsePipelineSpec, type PipelineGraph } from '../../src/core/graph';
import { toMermaid } from '../../src/core/mermaid';
import { PreviewController } from '../../src/host/previewController';

const sample = parsePipelineSpec(readFileSync(join(__dirname, '..', 'fixtures', 'simple.yaml'), 'utf8'));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(load: (signal: AbortSignal) => Promise<PipelineGraph> = async () => sample) {
  let changed: () => void = () => {};
  const subscription = { dispose: vi.fn() };
  const panel = {
    showLoading: vi.fn(),
    showGraph: vi.fn(),
    showError: vi.fn(),
    showSizeWarning: vi.fn(),
  };
  const controller = new PreviewController({
    sourceUri: 'file:///work/pipeline.py',
    load,
    panel,
    subscribeChanges: (listener) => { changed = listener; return subscription; },
    debounceMs: 250,
  });
  return { controller, panel, changed: () => changed(), subscription };
}

function graphWithEdges(edgeCount: number): PipelineGraph {
  const tasks = Array.from({ length: 33 }, (_, index) => ({
    id: `t${index}`, key: `t${index}`, label: `Task ${index}`,
    componentName: '', inputs: [], dependencies: [],
  }));
  const edges = Array.from({ length: edgeCount }, (_, index) => ({
    from: tasks[Math.floor(index / tasks.length)].id,
    to: tasks[index % tasks.length].id,
    kind: 'order' as const,
    labels: [],
  }));
  return { root: { id: 'root', label: 'Pipeline', tasks, edges }, nodeCount: tasks.length, edgeCount };
}

function graphWithSourceLength(length: number): PipelineGraph {
  const graph = structuredClone(sample);
  graph.root.tasks = [graph.root.tasks[0]];
  graph.root.edges = [];
  graph.nodeCount = 1;
  graph.edgeCount = 0;
  graph.root.tasks[0].label = '';
  graph.root.tasks[0].label = 'x'.repeat(length - toMermaid(graph).length);
  return graph;
}

afterEach(() => vi.useRealTimers());

describe('PreviewController', () => {
  it('keeps layout through refresh and collapse, and copies the displayed direction without recompiling', async () => {
    const load = vi.fn(async () => sample);
    const h = harness(load);
    await h.controller.start();
    expect(h.controller.getMermaidSource()).toMatch(/^flowchart LR\n/);
    h.controller.setDirection('TB');
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.panel.showGraph).toHaveBeenLastCalledWith(sample, expect.stringMatching(/^flowchart TB\n/), undefined);
    h.controller.collapse('root/group');
    await h.controller.refresh();
    expect(h.controller.getMermaidSource()).toMatch(/^flowchart TB\n/);
    h.controller.setDirection('LR');
    expect(h.controller.getMermaidSource()).toMatch(/^flowchart LR\n/);
  });

  it('preserves stale errors and size gates when layout changes', async () => {
    const h = harness(vi.fn().mockResolvedValueOnce(sample).mockRejectedValueOnce(new Error('broken import')));
    await h.controller.start();
    await h.controller.refresh();
    h.controller.setDirection('TB');
    expect(h.panel.showGraph).toHaveBeenLastCalledWith(sample, expect.stringMatching(/^flowchart TB\n/), 'broken import');
    const large = harness(async () => ({ ...sample, nodeCount: 501 }));
    await large.controller.start();
    large.controller.setDirection('TB');
    expect(large.panel.showGraph).not.toHaveBeenCalled();
    large.controller.renderAnyway();
    expect(large.panel.showGraph).toHaveBeenLastCalledWith(expect.anything(), expect.stringMatching(/^flowchart TB\n/), undefined);
  });

  it('compiles immediately on explicit start and updates after saving its source', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => sample);
    const h = harness(load);
    await h.controller.start();
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.panel.showGraph).toHaveBeenCalledTimes(1);
    h.changed();
    await vi.advanceTimersByTimeAsync(249);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of save and watcher events into one compile', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => sample);
    const h = harness(load);
    await h.controller.start();
    h.changed();
    await vi.advanceTimersByTimeAsync(100);
    h.changed();
    h.changed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never displays an older compile that finishes after a newer save', async () => {
    vi.useFakeTimers();
    const first = deferred<PipelineGraph>();
    const second = deferred<PipelineGraph>();
    const load = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const h = harness(load);
    const initial = h.controller.start();
    h.changed();
    await vi.advanceTimersByTimeAsync(250);
    second.resolve(sample);
    await Promise.resolve();
    first.resolve(sample);
    await initial;
    expect(h.panel.showGraph).toHaveBeenCalledTimes(1);
  });

  it('retains the last good diagram when a later compile fails', async () => {
    const load = vi.fn().mockResolvedValueOnce(sample).mockRejectedValueOnce(new Error('broken import'));
    const h = harness(load);
    await h.controller.start();
    await h.controller.refresh();
    expect(h.panel.showError).toHaveBeenCalledWith('broken import', true);
    expect(h.controller.getMermaidSource()).toContain('Hello');
    h.controller.collapse('root/group');
    expect(h.panel.showGraph).toHaveBeenLastCalledWith(sample, expect.any(String), 'broken import');
  });

  it('stops listening and cancels refresh after disposal', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => sample);
    const h = harness(load);
    await h.controller.start();
    h.controller.dispose();
    h.changed();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.subscription.dispose).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('aborts an active load and ignores its result after disposal', async () => {
    const pending = deferred<PipelineGraph>();
    let signal: AbortSignal | undefined;
    const h = harness((active) => { signal = active; return pending.promise; });
    const started = h.controller.start();
    expect(signal?.aborted).toBe(false);
    h.controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(h.subscription.dispose).toHaveBeenCalledTimes(1);
    pending.resolve(sample);
    await started;
    expect(h.panel.showGraph).not.toHaveBeenCalled();
  });

  it('renders 1,000 edges but warns at 1,001, then renders on request', async () => {
    const allowed = graphWithEdges(1_000);
    const h = harness(async () => allowed);
    await h.controller.start();
    expect(h.panel.showSizeWarning).not.toHaveBeenCalled();
    expect(h.panel.showGraph).toHaveBeenCalledTimes(1);

    const oversized = graphWithEdges(1_001);
    const warned = harness(async () => oversized);
    await warned.controller.start();
    expect(warned.panel.showSizeWarning).toHaveBeenCalledWith(33, 1_001);
    expect(warned.panel.showGraph).not.toHaveBeenCalled();
    warned.controller.renderAnyway();
    expect(warned.panel.showGraph).toHaveBeenCalledWith(oversized, expect.any(String), undefined);
  });

  it('renders 50,000 Mermaid characters but warns at 50,001, then renders on request', async () => {
    const allowed = graphWithSourceLength(50_000);
    const h = harness(async () => allowed);
    await h.controller.start();
    expect(h.controller.getMermaidSource()).toHaveLength(50_000);
    expect(h.panel.showSizeWarning).not.toHaveBeenCalled();
    expect(h.panel.showGraph).toHaveBeenCalledTimes(1);

    const oversized = graphWithSourceLength(50_001);
    const warned = harness(async () => oversized);
    await warned.controller.start();
    expect(warned.controller.getMermaidSource()).toHaveLength(50_001);
    expect(warned.panel.showSizeWarning).toHaveBeenCalledWith(1, 0);
    expect(warned.panel.showGraph).not.toHaveBeenCalled();
    warned.controller.renderAnyway();
    expect(warned.panel.showGraph).toHaveBeenCalledWith(oversized, expect.any(String), undefined);
  });

  it('pauses oversized graphs until the user asks to render them', async () => {
    const graph = { ...sample, nodeCount: 501, edgeCount: 1001 };
    const h = harness(async () => graph);
    await h.controller.start();
    expect(h.panel.showSizeWarning).toHaveBeenCalledWith(501, 1001);
    expect(h.panel.showGraph).not.toHaveBeenCalled();
    h.controller.renderAnyway();
    expect(h.panel.showGraph).toHaveBeenCalledTimes(1);
  });
});
