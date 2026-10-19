import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parsePipelineSpec } from '../../src/core/graph';
import { toMermaid } from '../../src/core/mermaid';

const graph = (name: string) =>
  parsePipelineSpec(readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8'));

describe('toMermaid', () => {
  it('supports top-to-bottom layout without changing tasks, links, or collapsed groups', () => {
    const nested = graph('nested.yaml');
    for (const collapsed of [new Set<string>(), new Set(['root/group'])]) {
      const horizontal = toMermaid(nested, collapsed);
      const vertical = toMermaid(nested, collapsed, 'TB');
      expect(vertical).toBe(horizontal.replace('flowchart LR\n', 'flowchart TB\n'));
    }
  });

  it('renders tasks and uses different arrows for data and ordering', () => {
    const source = toMermaid(graph('data.yaml'));
    expect(source.startsWith('flowchart LR\n')).toBe(true);
    expect(source).toContain('Ingest');
    expect(source).toContain('Train');
    expect(source).toContain('-->|dataset ← data, rows ← count|');
    expect(source).toContain('-.->');
  });

  it('renders nested DAGs as subgraphs and allows a collapsed view', () => {
    const nested = graph('nested.yaml');
    const expanded = toMermaid(nested);
    const collapsed = toMermaid(nested, new Set(['root/group']));
    expect(expanded).toContain('subgraph ');
    expect(expanded).toContain('Child');
    expect(collapsed).not.toContain('subgraph ');
    expect(collapsed).not.toContain('Child');
    expect(collapsed).toContain('Group');
  });

  it('uses stable order and escapes reserved label characters as text', () => {
    const pipeline = graph('simple.yaml');
    pipeline.root.tasks[0].label = 'Say "[hi]" <script>` 🌻';
    const source = toMermaid(pipeline);
    expect(source).toBe(toMermaid(pipeline));
    expect(source).toContain('Say #quot;#91;hi#93;#quot; #lt;script#gt;#96; 🌻');
    expect(source).not.toContain('<script>');
  });

  it('generates IDs without Node globals so the bundled webview can use them', () => {
    vi.stubGlobal('Buffer', undefined);
    try {
      expect(() => toMermaid(graph('nested.yaml'))).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
