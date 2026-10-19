import type { PipelineGraph } from '../core/graph';
import { toMermaid, type DagDirection } from '../core/mermaid';

export type PreviewPanel = {
  showLoading(): void;
  showGraph(graph: PipelineGraph, mermaidSource: string, staleError?: string): void;
  showError(message: string, stale: boolean): void;
  showSizeWarning(nodeCount: number, edgeCount: number): void;
};

export type PreviewOptions = {
  sourceUri: string;
  load(signal: AbortSignal): Promise<PipelineGraph>;
  panel: PreviewPanel;
  subscribeChanges(listener: () => void): { dispose(): void };
  debounceMs?: number;
  reportError?(error: Error): void;
};

export class PreviewController {
  private generation = 0;
  private active?: AbortController;
  private changeSubscription?: { dispose(): void };
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastGraph?: PipelineGraph;
  private lastError?: string;
  private mermaidSource = '';
  private direction: DagDirection = 'LR';
  private readonly collapsed = new Set<string>();
  private allowLargeGraph = false;

  constructor(private readonly options: PreviewOptions) {}

  start(): Promise<void> {
    if (!this.changeSubscription) {
      this.changeSubscription = this.options.subscribeChanges(() => this.onChange());
    }
    return this.refresh();
  }

  private onChange(): void {
    if (this.disposed) return;
    this.generation++;
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.options.debounceMs ?? 250);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const generation = ++this.generation;
    this.active?.abort();
    const active = new AbortController();
    this.active = active;
    this.options.panel.showLoading();
    try {
      const graph = await this.options.load(active.signal);
      if (this.disposed || generation !== this.generation) return;
      this.lastGraph = graph;
      this.lastError = undefined;
      this.allowLargeGraph = false;
      this.showGraphOrWarning();
    } catch (cause) {
      if (this.disposed || generation !== this.generation) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.lastError = error.message;
      this.options.reportError?.(error);
      this.options.panel.showError(error.message, Boolean(this.lastGraph));
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  private showGraphOrWarning(): void {
    const graph = this.lastGraph;
    if (!graph) return;
    this.mermaidSource = toMermaid(graph, this.collapsed, this.direction);
    if (!this.allowLargeGraph && (graph.nodeCount > 500 || graph.edgeCount > 1_000 || this.mermaidSource.length > 50_000)) {
      this.options.panel.showSizeWarning(graph.nodeCount, graph.edgeCount);
      return;
    }
    this.options.panel.showGraph(graph, this.mermaidSource, this.lastError);
  }

  collapse(scopeId: string): void {
    if (this.collapsed.has(scopeId)) this.collapsed.delete(scopeId);
    else this.collapsed.add(scopeId);
    this.showGraphOrWarning();
  }

  setDirection(direction: DagDirection): void {
    if (this.disposed || this.direction === direction) return;
    this.direction = direction;
    this.showGraphOrWarning();
  }

  renderAnyway(): void {
    this.allowLargeGraph = true;
    this.showGraphOrWarning();
  }

  getMermaidSource(): string {
    return this.mermaidSource;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.changeSubscription?.dispose();
  }
}
