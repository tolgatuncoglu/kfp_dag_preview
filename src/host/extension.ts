import * as vscode from 'vscode';
import { parsePipelineSpec } from '../core/graph';
import { compilePipeline } from './compiler';
import { resolveKfpExecutable } from './environment';
import { subscribeChanges } from './changes';
import { createDagPanel, type DagPanel } from './panel';
import { discoverPipelineNames } from './pipelines';
import { PreviewController } from './previewController';

function activeUri(provided?: vscode.Uri): vscode.Uri | undefined {
  return provided ?? vscode.window.activeTextEditor?.document.uri;
}

export async function selectPipeline(source: string): Promise<string | undefined> {
  const names = discoverPipelineNames(source);
  if (names.length > 0) {
    const manual = 'Enter function name…';
    const picked = await vscode.window.showQuickPick([...names, manual], {
      placeHolder: 'Select a KFP pipeline to preview',
    });
    if (!picked) return undefined;
    if (picked !== manual) return picked;
  }
  return vscode.window.showInputBox({
    prompt: 'Pipeline function name',
    placeHolder: 'my_pipeline',
    validateInput: (value) => /^\w+$/.test(value) ? undefined : 'Enter a Python function name',
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('KFP DAG Preview');
  context.subscriptions.push(output);

  const openPanels = new Map<string, DagPanel>();
  // One aggregate disposer: panels remove themselves from openPanels on disposal, so iterate a copy.
  context.subscriptions.push({ dispose: () => [...openPanels.values()].forEach((panel) => panel.dispose()) });

  async function openPreview(uri: vscode.Uri, python: boolean, functionName: string | undefined, load: (signal: AbortSignal) => Promise<ReturnType<typeof parsePipelineSpec>>): Promise<void> {
    const key = `${uri.toString()}\n${functionName ?? ''}`;
    const existing = openPanels.get(key);
    if (existing) { existing.reveal(); return; }
    let controller: PreviewController | undefined;
    let closed = false;
    const panel: DagPanel = createDagPanel(uri, {
      refresh: () => { void controller?.refresh(); },
      copyMermaid: () => {
        const source = controller?.getMermaidSource();
        if (source) void vscode.env.clipboard.writeText(source);
      },
      collapse: (scopeId) => controller?.collapse(scopeId),
      setDirection: (direction) => controller?.setDirection(direction),
      renderAnyway: () => controller?.renderAnyway(),
      showOutput: () => output.show(true),
      disposed: () => {
        closed = true;
        controller?.dispose();
        if (openPanels.get(key) === panel) openPanels.delete(key);
      },
    });
    openPanels.set(key, panel);
    await panel.whenReady();
    if (closed) return;
    controller = new PreviewController({
      sourceUri: uri.toString(),
      load,
      panel,
      subscribeChanges: (listener) => subscribeChanges(vscode, uri, python, listener),
      reportError: (error) => output.appendLine(`[${new Date().toISOString()}] ${uri.fsPath}\n${error.stack ?? error.message}\n`),
    });
    await controller.start();
  }

  context.subscriptions.push(vscode.commands.registerCommand('kfpDagPreview.previewPython', async (provided?: vscode.Uri, requested?: unknown) => {
    if (!vscode.workspace.isTrusted) {
      await vscode.window.showErrorMessage('KFP DAG Preview needs a trusted workspace to compile Python pipeline code.');
      return;
    }
    const uri = activeUri(provided);
    if (!uri || uri.scheme !== 'file' || !uri.fsPath.endsWith('.py')) {
      await vscode.window.showErrorMessage('Open a local Python pipeline file to preview its DAG.');
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      // Editor-title menus pass a context object as the second argument, not a function name.
      const functionName = typeof requested === 'string' && requested ? requested : await selectPipeline(document.getText());
      if (!functionName) return;
      await openPreview(uri, true, functionName, async (signal) => {
        const configured = vscode.workspace.getConfiguration('kfpDagPreview', uri).get<string>('kfpExecutable');
        const executable = await resolveKfpExecutable(uri, configured || undefined);
        const yaml = await compilePipeline({ filePath: uri.fsPath, functionName, executable, signal });
        return parsePipelineSpec(yaml);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      await vscode.window.showErrorMessage(`KFP DAG Preview: ${message}`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('kfpDagPreview.previewYaml', async (provided?: vscode.Uri) => {
    const uri = activeUri(provided);
    if (!uri || !['file', 'vscode-remote'].includes(uri.scheme)) {
      await vscode.window.showErrorMessage('Open a compiled KFP v2 YAML file to preview its DAG.');
      return;
    }
    try {
      await openPreview(uri, false, undefined, async () => {
        const document = await vscode.workspace.openTextDocument(uri);
        return parsePipelineSpec(document.getText());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      await vscode.window.showErrorMessage(`KFP DAG Preview: ${message}`);
    }
  }));
}

export function deactivate(): void {}
