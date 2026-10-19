import mermaid from 'mermaid';
import type { GraphTask, PipelineGraph } from '../core/graph';
import { mermaidNodeId } from '../core/mermaid';
import { initializeMermaid } from './mermaidSetup';
import { enablePanning } from './pan';
import { PreviewStatus, summarizeError } from './previewStatus';
import { indexNodesByMermaidId, reconcileTaskDetails, tasksIn } from './taskSelection';
import { readMermaidTheme, watchVsCodeTheme } from './theme';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = byId<HTMLDivElement>('status');
const diagram = byId<HTMLDivElement>('diagram');
const canvas = byId<HTMLElement>('canvas');
const warning = byId<HTMLDivElement>('warning');
const taskList = byId<HTMLSelectElement>('task-list');
const taskDetail = byId<HTMLDivElement>('task-detail');
let currentGraph: PipelineGraph | undefined;
let currentSource = '';
let renderGeneration = 0;
let scale = 1;
let renderedDirection = 'flowchart LR';
const previewStatus = new PreviewStatus();
enablePanning(canvas);

let themeSignature = '';
function applyTheme(): void {
  const dark = document.body.classList.contains('vscode-dark') ||
    (document.body.classList.contains('vscode-high-contrast') && !document.body.classList.contains('vscode-high-contrast-light'));
  const theme = readMermaidTheme(getComputedStyle(document.body), dark);
  const signature = JSON.stringify(theme);
  if (signature === themeSignature) return;
  if (themeSignature) mermaid.mermaidAPI.updateSiteConfig(theme);
  else initializeMermaid(theme);
  themeSignature = signature;
  if (currentSource) void render();
}

applyTheme();
watchVsCodeTheme(document.body, applyTheme);

function detail(task: GraphTask): void {
  taskList.value = task.id;
  taskDetail.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = task.label;
  taskDetail.append(heading);
  const items = [
    ['Component', task.componentName || '—'],
    ['Condition', task.condition || '—'],
    ['Trigger', task.triggerStrategy || '—'],
    ['Loop', task.iterator || '—'],
    ['Inputs', task.inputs.map((input) => `${input.name}: ${input.sourceDescription}`).join(', ') || '—'],
    ['Dependencies', task.dependencies.join(', ') || '—'],
  ];
  for (const [label, value] of items) {
    const row = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = `${label}: `;
    row.append(strong, document.createTextNode(value));
    taskDetail.append(row);
  }
  if (task.childScope) {
    const button = document.createElement('button');
    button.textContent = 'Expand or collapse group';
    button.addEventListener('click', () => vscode.postMessage({ type: 'collapse', scopeId: task.childScope!.id }));
    taskDetail.append(button);
  }
}

function renderTaskList(graph: PipelineGraph): void {
  const selected = taskList.value;
  taskList.replaceChildren(new Option('Select a task', ''));
  for (const task of tasksIn(graph.root)) taskList.add(new Option(task.label, task.id));
  reconcileTaskDetails(graph, selected, detail, () => taskDetail.replaceChildren());
}

async function render(): Promise<void> {
  const generation = ++renderGeneration;
  const direction = currentSource.split('\n', 1)[0];
  try {
    const { svg } = await mermaid.render(`kfp-dag-${generation}`, currentSource);
    if (generation !== renderGeneration) return;
    diagram.innerHTML = svg;
    if (direction !== renderedDirection) {
      canvas.scrollTo(0, 0);
      renderedDirection = direction;
    }
    const nodes = indexNodesByMermaidId(diagram.querySelectorAll<SVGGElement>('g.node'));
    for (const task of currentGraph ? tasksIn(currentGraph.root) : []) {
      const element = nodes.get(mermaidNodeId(task.id));
      if (element) {
        element.style.cursor = 'pointer';
        element.addEventListener('click', () => detail(task));
      }
    }
    status.textContent = previewStatus.rendered(currentGraph?.nodeCount ?? 0, currentGraph?.edgeCount ?? 0);
  } catch (error) {
    // Mermaid leaves its error SVG (and a temp container) in document.body when render() throws.
    document.getElementById(`kfp-dag-${generation}`)?.remove();
    document.getElementById(`dkfp-dag-${generation}`)?.remove();
    if (generation !== renderGeneration) return;
    status.textContent = `Diagram rendering failed: ${summarizeError(error instanceof Error ? error.message : String(error))}`;
  }
}

taskList.addEventListener('change', () => {
  const task = currentGraph && tasksIn(currentGraph.root).find((candidate) => candidate.id === taskList.value);
  if (task) detail(task);
});
byId<HTMLButtonElement>('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
byId<HTMLSelectElement>('layout').addEventListener('change', (event) => {
  vscode.postMessage({ type: 'setDirection', direction: (event.target as HTMLSelectElement).value });
});
byId<HTMLButtonElement>('copy').addEventListener('click', () => vscode.postMessage({ type: 'copyMermaid' }));
byId<HTMLButtonElement>('show-output').addEventListener('click', () => vscode.postMessage({ type: 'showOutput' }));
byId<HTMLButtonElement>('render-anyway').addEventListener('click', () => {
  warning.hidden = true;
  vscode.postMessage({ type: 'renderAnyway' });
});
byId<HTMLButtonElement>('zoom-in').addEventListener('click', () => {
  scale = Math.min(4, scale * 1.2);
  diagram.style.transform = `scale(${scale})`;
});
byId<HTMLButtonElement>('zoom-out').addEventListener('click', () => {
  // Fit can be below the usual zoom floor; never enlarge the graph on zoom out.
  scale = Math.min(scale, Math.max(0.2, scale / 1.2));
  diagram.style.transform = `scale(${scale})`;
});
byId<HTMLButtonElement>('fit').addEventListener('click', () => {
  const svg = diagram.querySelector('svg');
  if (!svg) return;
  const width = svg.getBoundingClientRect().width / scale;
  const height = svg.getBoundingClientRect().height / scale;
  if (width <= 0 || height <= 0) return;
  scale = Math.min(1, Math.max(1, canvas.clientWidth - 24) / width, Math.max(1, canvas.clientHeight - 24) / height);
  diagram.style.transform = `scale(${scale})`;
  canvas.scrollTo(0, 0);
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as Record<string, unknown>;
  switch (message.type) {
    case 'loading':
      status.textContent = previewStatus.loading();
      break;
    case 'graph':
      currentGraph = message.graph as PipelineGraph;
      currentSource = message.mermaidSource as string;
      status.textContent = previewStatus.graph(typeof message.staleError === 'string' ? message.staleError : undefined) ?? 'Rendering diagram…';
      warning.hidden = true;
      byId<HTMLButtonElement>('show-output').hidden = typeof message.staleError !== 'string';
      renderTaskList(currentGraph);
      void render();
      break;
    case 'error':
      status.textContent = previewStatus.error(String(message.message), Boolean(message.stale));
      byId<HTMLButtonElement>('show-output').hidden = false;
      if (!message.stale) diagram.replaceChildren();
      break;
    case 'sizeWarning':
      warning.hidden = false;
      byId<HTMLSpanElement>('warning-text').textContent = `Large graph: ${message.nodeCount} tasks, ${message.edgeCount} links. `;
      status.textContent = previewStatus.sizeWarning();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
