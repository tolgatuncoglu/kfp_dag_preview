import type { GraphScope, GraphTask, PipelineGraph } from './graph';

export type DagDirection = 'LR' | 'TB';

const hexId = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const mermaidNodeId = (taskId: string): string => `n${hexId(taskId)}`;

function escapeLabel(value: string): string {
  const codes: Record<string, string> = {
    '&': '#amp;',
    '#': '#35;',
    '"': '#quot;',
    '[': '#91;',
    ']': '#93;',
    '<': '#lt;',
    '>': '#gt;',
    '`': '#96;',
    '|': '#124;',
    ';': '#59;',
  };
  return Array.from(value).map((character) =>
    codes[character] ?? (/\s/.test(character) && character !== ' ' ? ' ' : character),
  ).join('');
}

function displayLabel(task: GraphTask, collapsed: boolean): string {
  const suffix = [task.condition ? '◇' : '', task.iterator ? '↻' : '', collapsed ? '+' : '']
    .filter(Boolean).join(' ');
  return escapeLabel(suffix ? `${task.label} ${suffix}` : task.label);
}

function emitScope(scope: GraphScope, lines: string[], indent: string, collapsed: ReadonlySet<string>): void {
  for (const task of scope.tasks) {
    const isCollapsed = task.childScope !== undefined && collapsed.has(task.childScope.id);
    if (task.childScope && !isCollapsed) {
      lines.push(`${indent}subgraph s${hexId(task.id)}["${escapeLabel(task.label)}"]`);
      lines.push(`${indent}  ${mermaidNodeId(task.id)}["${displayLabel(task, false)}"]`);
      emitScope(task.childScope, lines, `${indent}  `, collapsed);
      lines.push(`${indent}end`);
    } else {
      lines.push(`${indent}${mermaidNodeId(task.id)}["${displayLabel(task, isCollapsed)}"]`);
    }
  }
  for (const edge of scope.edges) {
    const from = mermaidNodeId(edge.from);
    const to = mermaidNodeId(edge.to);
    if (edge.kind === 'order') lines.push(`${indent}${from} -.-> ${to}`);
    else {
      const label = edge.labels.length ? `|${escapeLabel(edge.labels.join(', '))}|` : '';
      lines.push(`${indent}${from} -->${label} ${to}`);
    }
  }
}

export function toMermaid(
  graph: PipelineGraph,
  collapsedScopeIds: ReadonlySet<string> = new Set(),
  direction: DagDirection = 'LR',
): string {
  const lines = [`flowchart ${direction}`];
  emitScope(graph.root, lines, '  ', collapsedScopeIds);
  return `${lines.join('\n')}\n`;
}
