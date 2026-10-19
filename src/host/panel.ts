import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Uri, WebviewPanel } from 'vscode';
import type { PipelineGraph } from '../core/graph';
import type { DagDirection } from '../core/mermaid';

export type PanelCallbacks = {
  refresh(): void;
  copyMermaid(): void;
  collapse(scopeId: string): void;
  setDirection(direction: DagDirection): void;
  renderAnyway(): void;
  showOutput(): void;
  disposed(): void;
};

export class DagPanel {
  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  constructor(private readonly panel: WebviewPanel, private readonly callbacks: PanelCallbacks) {
    panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message));
    panel.onDidDispose(() => { this.resolveReady(); callbacks.disposed(); });
  }

  private receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { type?: unknown; scopeId?: unknown; direction?: unknown };
    switch (message.type) {
      case 'ready': this.resolveReady(); break;
      case 'refresh': this.callbacks.refresh(); break;
      case 'copyMermaid': this.callbacks.copyMermaid(); break;
      case 'collapse':
        if (typeof message.scopeId === 'string') this.callbacks.collapse(message.scopeId);
        break;
      case 'setDirection':
        if (message.direction === 'LR' || message.direction === 'TB') this.callbacks.setDirection(message.direction);
        break;
      case 'renderAnyway': this.callbacks.renderAnyway(); break;
      case 'showOutput': this.callbacks.showOutput(); break;
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  showLoading(): void {
    void this.panel.webview.postMessage({ type: 'loading' });
  }

  showGraph(graph: PipelineGraph, mermaidSource: string, staleError?: string): void {
    void this.panel.webview.postMessage({ type: 'graph', graph, mermaidSource, staleError });
  }

  showError(message: string, stale: boolean): void {
    void this.panel.webview.postMessage({ type: 'error', message, stale });
  }

  showSizeWarning(nodeCount: number, edgeCount: number): void {
    void this.panel.webview.postMessage({ type: 'sizeWarning', nodeCount, edgeCount });
  }

  reveal(): void {
    this.panel.reveal();
  }

  dispose(): void {
    this.panel.dispose();
  }
}

export function createDagPanel(sourceUri: Uri, callbacks: PanelCallbacks): DagPanel {
  const vscode = require('vscode') as typeof import('vscode');
  const panel = vscode.window.createWebviewPanel(
    'kfpDagPreview',
    `KFP DAG: ${vscode.workspace.asRelativePath(sourceUri, false)}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(__dirname)] },
  );
  const nonce = randomBytes(16).toString('base64');
  const script = panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, 'webview.js')));
  const style = panel.webview.asWebviewUri(vscode.Uri.file(join(__dirname, 'webview.css')));
  panel.webview.html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${panel.webview.cspSource} data:">
<link rel="stylesheet" href="${style}"><title>KFP DAG Preview</title></head>
<body>
  <header class="toolbar" aria-label="DAG controls">
    <button id="refresh" title="Refresh DAG">Refresh</button>
    <button id="copy" title="Copy Mermaid source">Copy Mermaid</button>
    <select id="layout" aria-label="DAG layout" title="DAG layout">
      <option value="LR">Horizontal</option>
      <option value="TB">Vertical</option>
    </select>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="fit" title="Fit diagram">Fit</button>
  </header>
  <div id="status" role="status" aria-live="polite">Waiting for compilation…</div>
  <button id="show-output" hidden>Show compiler output</button>
  <div id="warning" hidden><span id="warning-text"></span><button id="render-anyway">Render anyway</button></div>
  <main>
    <section id="canvas" aria-label="Pipeline DAG" title="Drag to pan; click a task for details" tabindex="0"><div id="diagram"></div></section>
    <aside id="details" aria-label="Task details"><h2>Task details</h2><select id="task-list" aria-label="Select task"><option value="">Select a task</option></select><div id="task-detail"></div></aside>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body></html>`;
  return new DagPanel(panel, callbacks);
}
