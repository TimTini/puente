import { expect, test } from '@playwright/test';
import type { Node as PuenteNode } from '@puente/shared';

const stopped = { state: 'stopped', origin: null, url: null, startedAt: null, lastError: null };
const node = (id: string, tunnelId: string | null): PuenteNode =>
  ({
    id,
    name: id,
    kind: 'local',
    tunnelId,
    quickTunnel: stopped,
    provisionState: tunnelId ? 'provisioned' : 'unprovisioned',
    connectorRunState: 'stopped',
    serviceInstalled: false,
  }) as PuenteNode;

test('custom domain publication selects a provisioned node even when the first node is a draft', async ({
  page,
}) => {
  const nodes = [node('draft', null), node('ready', 'named-ready')];
  let publishedNode: string | undefined;
  await fixtures(page, nodes, (id) => {
    publishedNode = id;
  });
  await page.goto('/routes');
  await page.getByRole('button', { name: 'Publish route', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#subdomain').fill('demo');
  await dialog.locator('#svc-port').fill('8080');
  await dialog.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect.poll(() => publishedNode).toBe('ready');
});

test('Remove deletes a stopped temporary configuration rather than disabling its button', async ({
  page,
}) => {
  const quick = node('quick', null);
  quick.quickTunnel = { ...stopped, origin: 'http://localhost:8080' };
  const methods: string[] = [];
  await fixtures(page, [quick]);
  await page.route('**/api/nodes/quick/quick-tunnel', async (route) => {
    methods.push(route.request().method());
    quick.quickTunnel = stopped;
    await route.fulfill({ json: quick });
  });
  await page.goto('/routes');
  const remove = page.getByTitle('Remove Temporary URL');
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(page.getByText('No routes yet', { exact: true })).toBeVisible();
  expect(methods).toEqual(['DELETE']);
});

async function fixtures(
  page: import('@playwright/test').Page,
  nodes: PuenteNode[],
  onPublish?: (id: string) => void,
) {
  await page.addInitScript(() => localStorage.setItem('puente_token', 'fixture-only'));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown = {};
    if (path === '/api/auth/me') data = { id: 'fixture', username: 'fixture', role: 'owner' };
    else if (path === '/api/setup/status') data = { hasAdmin: true, ready: true };
    else if (path === '/api/nodes') data = nodes;
    else if (path === '/api/routes') {
      data = [];
      if (request.method() === 'POST') onPublish?.(request.postDataJSON().nodeId);
    } else if (path === '/api/cloudflare/zones') data = [{ id: 'zone', name: 'example.test' }];
    else if (path === '/api/workspaces') data = [];
    else if (path === '/api/stream') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return;
    }
    await route.fulfill({ json: data });
  });
}
