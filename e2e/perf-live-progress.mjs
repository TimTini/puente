/* global window, document, requestAnimationFrame */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseURL = process.env.PUENTE_WEB_URL ?? 'http://127.0.0.1:5199';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(root, '.puente', 'browsers');
const { chromium } = await import('@playwright/test');
const nodes = Array.from({ length: 20 }, (_, i) => ({
  id: `node-${i}`,
  name: `Node ${i}`,
  kind: 'local',
  ssh: null,
  tunnelId: null,
  tunnelName: null,
  provisionState: i === 0 ? 'provisioning' : 'unprovisioned',
  connectorRunState: 'unknown',
  tunnelStatus: null,
  serviceInstalled: false,
  os: null,
  arch: null,
  cloudflaredVersion: null,
  connectionCount: null,
  lastError: null,
  lastSeenAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  quickTunnel: {
    origin: null,
    url: null,
    state: 'stopped',
    startedAt: null,
    lastError: null,
  },
}));

async function scrollTrace(page) {
  const cdp = await page.context().newCDPSession(page);
  const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline',
    transferMode: 'ReturnAsStream',
  });
  const maxScroll = await page.evaluate(async () => {
    const main = document.querySelector('main');
    if (!main) throw new Error('Shell main scroll container was not found');
    const maxScroll = main.scrollHeight - main.clientHeight;
    if (maxScroll <= 0) throw new Error('Fixture page does not overflow the main scroll container');
    for (let i = 0; i < 24; i += 1) {
      main.scrollTop = (i % 2 === 0 ? 1 : 0.4) * maxScroll;
      await new Promise(requestAnimationFrame);
    }
    main.scrollTop = 0;
    await new Promise(requestAnimationFrame);
    return maxScroll;
  });
  assert(maxScroll > 0, 'the page must scroll to profile card rendering');
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  let trace = '';
  let eof = false;
  while (!eof) {
    const part = await cdp.send('IO.read', { handle: stream });
    trace += part.data;
    eof = part.eof;
  }
  await cdp.send('IO.close', { handle: stream });
  await cdp.detach();
  const events = JSON.parse(trace).traceEvents;
  return Object.fromEntries(
    ['Paint', 'RasterTask'].map((name) => {
      const matched = events.filter((event) => event.name === name && event.dur);
      return [
        name,
        {
          count: matched.length,
          totalMs: matched.reduce((sum, event) => sum + event.dur, 0) / 1000,
        },
      ];
    }),
  );
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PUENTE_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PUENTE_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('puente_token', 'fixture-token');
    window.__nodeCardRenders = {};
    window.EventSource = class {
      constructor() {
        window.__emitSse = (data) => this.onmessage?.({ data: JSON.stringify(data) });
        queueMicrotask(() => this.onopen?.());
      }
      close() {}
    };
  });
  await page.route('**/src/components/NodeCard.tsx*', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const signature = 'function NodeCard({ node, routeCount, onAddRoute }) {';
    assert(body.includes(signature), 'NodeCard Vite module signature changed; update this fixture');
    await route.fulfill({
      response,
      body: body.replace(
        signature,
        `${signature}\n  window.__nodeCardRenders[node.id] = (window.__nodeCardRenders[node.id] ?? 0) + 1;`,
      ),
    });
  });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    const body =
      path === '/setup/status'
        ? { hasAdmin: true }
        : path === '/auth/me'
          ? { id: 'fixture-owner', username: 'owner', role: 'owner' }
          : path === '/nodes'
            ? nodes
            : path === '/routes' || path.startsWith('/events') || path === '/cloudflare/zones'
              ? []
              : path === '/cloudflare/connection'
                ? { connected: false, account: null, zones: [] }
                : path === '/license'
                  ? { edition: 'community', features: [] }
                  : path === '/workspaces'
                    ? []
                    : {};
    await route.fulfill({ json: body });
  });

  await page.goto(`${baseURL}/nodes`);
  await page.getByRole('main').getByRole('heading', { name: 'Nodes' }).waitFor();
  await page.getByText('Node 19', { exact: true }).waitFor();
  await page.waitForFunction(
    () => window.__emitSse && Object.keys(window.__nodeCardRenders).length === 20,
  );
  const before = await page.evaluate(() => ({ ...window.__nodeCardRenders }));
  await page.evaluate(() =>
    window.__emitSse({
      type: 'progress',
      scope: 'node:node-0',
      step: 'connect',
      message: 'Fixture progress',
      done: false,
      error: false,
    }),
  );
  await page.getByText('Fixture progress', { exact: true }).waitFor();
  const after = await page.evaluate(() => ({ ...window.__nodeCardRenders }));

  await scrollTrace(page);
  const backdropTraces = [];
  for (let i = 0; i < 3; i += 1) backdropTraces.push(await scrollTrace(page));
  await page.addStyleTag({
    content:
      '[data-slot="card"] { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }',
  });
  await scrollTrace(page);
  const noCardBlurTraces = [];
  for (let i = 0; i < 3; i += 1) noCardBlurTraces.push(await scrollTrace(page));

  assert(after['node-0'] > before['node-0'], 'the matching card must rerender for new progress');
  const unrelatedRenders = nodes
    .slice(1)
    .filter((node) => after[node.id] > before[node.id])
    .map((node) => node.id);
  assert.deepEqual(
    unrelatedRenders,
    [],
    `unrelated node cards rerendered for node-0 progress: ${unrelatedRenders.join(', ')}`,
  );
  assert.deepEqual(pageErrors, [], `frontend errors: ${pageErrors.join('; ')}`);
  console.log(
    JSON.stringify({
      cards: nodes.length,
      matchingCardRenders: after['node-0'] - before['node-0'],
      unrelatedCardRenders: unrelatedRenders.length,
      scrollTrace: { backdropBlur: backdropTraces, noCardBlur: noCardBlurTraces },
    }),
  );
} finally {
  await browser.close();
}
