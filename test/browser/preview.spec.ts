import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import { parsePipelineSpec, type PipelineGraph } from '../../src/core/graph';
import { mermaidNodeId } from '../../src/core/mermaid';
import { PreviewController } from '../../src/host/previewController';
import type { DagPanel, PanelCallbacks } from '../../src/host/panel';

// Use the production HTML, message router, controller and bundled Mermaid. Only the
// VS Code transport is replaced, so browser assertions exercise the actual webview.
const panelBundle = buildSync({
  entryPoints: ['src/host/panel.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['vscode'], write: false,
}).outputFiles[0].text;

async function openPreview(page: Page, fixture = 'data.yaml', providedGraph?: PipelineGraph) {
  const graph = providedGraph ?? parsePipelineSpec(readFileSync(resolve('test/fixtures', fixture), 'utf8'));
  let html = '';
  let receive: (message: unknown) => void = () => {};
  let copied = '';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const vscode = {
    Uri: { file: (path: string) => path }, ViewColumn: { Beside: 2 },
    workspace: { asRelativePath: () => fixture },
    window: { createWebviewPanel: () => ({
      webview: {
        cspSource: 'http://kfp.test',
        asWebviewUri: (path: string) => `http://kfp.test/${path.split('/').pop()}`,
        set html(value: string) {
          html = value.replace('<body>', `<body class="vscode-dark" style="
            --vscode-editor-foreground: #cccccc; --vscode-editor-background: #1f1f1f;
            --vscode-editorWidget-background: #252526; --vscode-panel-border: #454545;
            --vscode-button-foreground: #ffffff; --vscode-button-background: #3a3d41;
            --vscode-dropdown-background: #313131; --vscode-dropdown-foreground: #cccccc;
            --vscode-focusBorder: #007fd4; --vscode-font-family: sans-serif; --vscode-font-size: 13px;">`);
        },
        onDidReceiveMessage: (handler: typeof receive) => { receive = handler; },
        postMessage: (message: unknown) => page.evaluate((data) => window.postMessage(data, '*'), message),
      },
      onDidDispose() {},
    }) },
  };
  const module = { exports: {} as { createDagPanel(uri: unknown, callbacks: PanelCallbacks): DagPanel } };
  const require = createRequire(resolve('package.json'));
  runInNewContext(panelBundle, {
    module, exports: module.exports, __dirname: resolve('dist'),
    require: (name: string) => name === 'vscode' ? vscode : require(name),
  });
  let controller: PreviewController;
  const panel = module.exports.createDagPanel(fixture, {
    refresh: () => { void controller.refresh(); },
    copyMermaid: () => { copied = controller.getMermaidSource(); },
    setDirection: (direction) => controller.setDirection(direction),
    collapse: (scopeId) => controller.collapse(scopeId),
    renderAnyway: () => controller.renderAnyway(),
    showOutput() {}, disposed() {},
  });
  controller = new PreviewController({
    sourceUri: fixture, panel, load: async () => graph,
    subscribeChanges: () => ({ dispose() {} }),
  });
  await page.exposeFunction('sendToHost', (message: { type: string }) => {
    receive(message);
    if (message.type === 'ready') void controller.start();
  });
  await page.addInitScript(() => {
    (window as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => (window as any).sendToHost(message) });
  });
  await page.route('http://kfp.test/**', (route) => {
    const name = new URL(route.request().url()).pathname;
    if (name === '/') return route.fulfill({ contentType: 'text/html', body: html });
    if (name === '/webview.js' || name === '/webview.css') {
      return route.fulfill({ path: resolve(`dist${name}`), contentType: name.endsWith('.js') ? 'text/javascript' : 'text/css' });
    }
    return route.abort();
  });
  await page.goto('http://kfp.test/');
  await expect(page.locator('#status')).toHaveText(`${graph.nodeCount} tasks · ${graph.edgeCount} links`);
  return { graph, errors, copied: () => copied };
}

const node = (page: Page, id: string) => page.locator(`g.node[id*="-${mermaidNodeId(id)}-"]`);

async function screenshot(page: Page, name: string) {
  if (!process.env.KFP_SCREENSHOT_DIR) return;
  mkdirSync(process.env.KFP_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(process.env.KFP_SCREENSHOT_DIR, `${name}.png`) });
}

async function switchLayout(page: Page, direction: string) {
  const oldId = await page.locator('#diagram > svg').getAttribute('id');
  await page.getByLabel('DAG layout').selectOption(direction);
  await expect(page.locator('#diagram > svg')).not.toHaveAttribute('id', oldId!);
}

test('horizontal default, vertical placement, copy, refresh and task clicks', async ({ page }) => {
  const h = await openPreview(page);
  await expect(page.getByLabel('DAG layout')).toHaveValue('LR');
  const first = node(page, 'root/ingest');
  const second = node(page, 'root/train');
  const horizontal = [await first.boundingBox(), await second.boundingBox()];
  expect(horizontal[1]!.x).toBeGreaterThan(horizontal[0]!.x + horizontal[0]!.width);
  await screenshot(page, 'horizontal');
  await switchLayout(page, 'TB');
  const vertical = [await first.boundingBox(), await second.boundingBox()];
  expect(vertical[1]!.y).toBeGreaterThan(vertical[0]!.y + vertical[0]!.height);
  await second.click();
  await expect(page.locator('#task-detail h3')).toHaveText('Train');
  await screenshot(page, 'vertical-task-details');
  await page.getByRole('button', { name: 'Copy Mermaid', exact: true }).click();
  await expect.poll(h.copied).toMatch(/^flowchart TB\n/);
  const oldId = await page.locator('#diagram > svg').getAttribute('id');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#diagram > svg')).not.toHaveAttribute('id', oldId!);
  await expect(page.getByLabel('DAG layout')).toHaveValue('TB');
  await expect(page.locator('#task-detail h3')).toHaveText('Train');
  await switchLayout(page, 'LR');
  expect(h.errors).toEqual([]);
});

for (const direction of ['LR', 'TB']) {
  test(`zoomed ${direction} diagram pans without selecting tasks; the next click still works`, async ({ page }) => {
    const h = await openPreview(page, 'real-stress.yaml');
    if (direction === 'TB') await switchLayout(page, direction);
    const canvas = page.locator('#canvas');
    for (let i = 0; i < 4; i++) await page.getByTitle('Zoom in', { exact: true }).click();
    // Starting over a node must pan too, without opening its details.
    const task = page.locator('#diagram g.node').first();
    await task.scrollIntoViewIfNeeded();
    const box = (await task.boundingBox())!;
    const before = await canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 130, y - 100, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('#task-detail')).toBeEmpty();
    const after = await canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    expect(after.x > before.x || after.y > before.y).toBe(true);
    await screenshot(page, `zoomed-${direction}-panned`);
    await expect(canvas).not.toHaveClass(/panning/);
    await task.click();
    await expect(page.locator('#task-detail h3')).not.toBeEmpty();
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expect.poll(() => canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual({ x: 0, y: 0 });
    const diagram = (await page.locator('#diagram svg').boundingBox())!;
    const viewport = (await canvas.boundingBox())!;
    expect(diagram.width).toBeLessThanOrEqual(viewport.width);
    expect(diagram.height).toBeLessThanOrEqual(viewport.height);
    expect(h.errors).toEqual([]);
  });
}

test('small pointer movement still selects a task and right-button drag does not pan', async ({ page }) => {
  await openPreview(page);
  const task = node(page, 'root/ingest');
  const box = (await task.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.up();
  await expect(page.locator('#task-detail h3')).toHaveText('Ingest');
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x - 100, y - 100);
  await page.mouse.up({ button: 'right' });
  await expect(page.locator('#canvas')).not.toHaveClass(/panning/);
});

test('background drag pans both axes, finishes outside the canvas and preserves selected details', async ({ page }) => {
  await openPreview(page, 'real-stress.yaml');
  const canvas = page.locator('#canvas');
  for (let i = 0; i < 4; i++) await page.getByTitle('Zoom in', { exact: true }).click();
  expect(await canvas.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight)).toBe(true);
  await page.getByLabel('Select task', { exact: true }).selectOption({ index: 1 });
  const selected = await page.locator('#task-detail h3').textContent();
  await canvas.evaluate((el) => { el.scrollLeft = 200; el.scrollTop = 200; });
  const box = (await canvas.boundingBox())!;
  // Canvas padding is outside the diagram and its nodes.
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 105, box.y + box.height - 85, { steps: 8 });
  await expect(canvas).toHaveClass(/panning/);
  const position = await canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
  expect(position.x).toBeGreaterThan(200);
  expect(position.y).toBeGreaterThan(200);
  await page.mouse.move(box.x + box.width + 50, box.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect(canvas).not.toHaveClass(/panning/);
  await expect(page.locator('#task-detail h3')).toHaveText(selected!);
});

for (const end of ['cancel', 'capture loss']) {
  test(`pan ${end} stops scrolling and allows the next node click`, async ({ page }) => {
    await openPreview(page, 'real-stress.yaml');
    const canvas = page.locator('#canvas');
    await canvas.evaluate((el) => {
      el.addEventListener('pointerdown', (event) => { el.dataset.pointerId = String((event as PointerEvent).pointerId); }, { once: true });
    });
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(420, 320, { steps: 8 });
    await expect(canvas).toHaveClass(/panning/);
    await canvas.evaluate((el, end) => {
      const pointerId = Number(el.dataset.pointerId);
      if (end === 'cancel') el.dispatchEvent(new PointerEvent('pointercancel', { pointerId }));
      else el.releasePointerCapture(pointerId);
    }, end);
    // Lost capture is delivered by the browser before the next pointer event.
    await page.mouse.move(400, 300);
    await expect(canvas).not.toHaveClass(/panning/);
    const position = await canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    await page.mouse.move(300, 200);
    expect(await canvas.evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }))).toEqual(position);
    await page.mouse.up();
    await page.locator('#diagram g.node').first().click();
    await expect(page.locator('#task-detail h3')).not.toBeEmpty();
  });
}

test('vertical nested groups collapse and expand, and controls fit a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 });
  const h = await openPreview(page, 'nested.yaml');
  await switchLayout(page, 'TB');
  await node(page, 'root/group').click();
  const child = node(page, 'root/group/child');
  await expect(child).toBeVisible();
  await page.getByRole('button', { name: 'Expand or collapse group' }).click();
  await expect(child).toHaveCount(0);
  await expect(page.getByLabel('DAG layout')).toHaveValue('TB');
  await page.getByRole('button', { name: 'Expand or collapse group' }).click();
  await expect(child).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const layout = (await page.getByLabel('DAG layout').boundingBox())!;
  expect(layout.x + layout.width).toBeLessThanOrEqual(380);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(380);
  await screenshot(page, 'narrow-vertical');
  expect(h.errors).toEqual([]);
});

test('Fit handles a tall graph in a short panel and Zoom out never enlarges it', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 400 });
  const tasks = Array.from({ length: 500 }, (_, i) => ({
    id: `t${i}`, key: `t${i}`, label: `Task ${i}`, componentName: '', inputs: [], dependencies: [],
  }));
  const edges = tasks.slice(1).map((task, i) => ({ from: tasks[i].id, to: task.id, kind: 'order' as const, labels: [] }));
  await openPreview(page, 'tall.yaml', { root: { id: 'root', label: 'Tall', tasks, edges }, nodeCount: 500, edgeCount: 499 });
  await switchLayout(page, 'TB');
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  const fitted = (await page.locator('#diagram svg').boundingBox())!;
  const canvas = (await page.locator('#canvas').boundingBox())!;
  expect.soft(fitted.height).toBeLessThanOrEqual(canvas.height);
  await page.getByTitle('Zoom out', { exact: true }).click();
  const smaller = (await page.locator('#diagram svg').boundingBox())!;
  expect(smaller.height).toBeLessThanOrEqual(fitted.height);
  await page.getByTitle('Zoom in', { exact: true }).click();
  expect((await page.locator('#diagram svg').boundingBox())!.height).toBeGreaterThan(smaller.height);
});
