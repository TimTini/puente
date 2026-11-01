import { useMemo, useState } from 'react';
import {
  ExternalLink,
  HeartPulse,
  Play,
  Plus,
  RotateCw,
  Square,
  Trash2,
  Waypoints,
} from 'lucide-react';
import {
  buildServiceUrl,
  type Node as PuenteNode,
  type Route as PuenteRoute,
} from '@puente/shared';
import { useNodes, useNodeMutations, useRoutes, useRouteMutations, useZones } from '../lib/hooks';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Spinner } from '../components/ui/spinner';
import { EmptyState, StatusBadge } from '../components/ui/extras';
import {
  isListedQuickTunnel,
  quickStateMeta,
  routeHealthMeta,
  routeStatusMeta,
} from '../lib/status';
import { CreateRouteDialog } from '../components/CreateRouteDialog';
import { cn } from '@/lib/utils';

export function RoutesPage() {
  const routes = useRoutes();
  const nodes = useNodes();
  const zones = useZones();
  const [open, setOpen] = useState(false);

  const nodeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of nodes.data ?? []) map.set(n.id, n.name);
    return map;
  }, [nodes.data]);

  const routeList = routes.data ?? [];
  const quickNodes = (nodes.data ?? []).filter((n) => isListedQuickTunnel(n.quickTunnel));
  const canPublish = (nodes.data ?? []).length > 0;
  const empty = routeList.length === 0 && quickNodes.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1100px] px-5 pb-16 pt-6 sm:px-7">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Routes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Temporary URLs and public subdomains mapped to services on your nodes.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!canPublish}>
          <Plus className="size-4" />
          Publish route
        </Button>
      </header>

      {routes.isLoading || nodes.isLoading ? (
        <div className="grid h-60 place-items-center">
          <Spinner className="size-8" />
        </div>
      ) : empty ? (
        <Card className="py-0">
          <EmptyState
            icon={<Waypoints className="size-6" />}
            title="No routes yet"
            description="Publish a temporary URL or a custom domain to a local service — e.g. port 7008 → vw.yourdomain.com."
            action={
              canPublish ? (
                <Button onClick={() => setOpen(true)}>
                  <Plus className="size-4" />
                  Publish your first route
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <Card className="gap-0 py-0">
          <div className="flex flex-col">
            {quickNodes.map((node, i) => (
              <QuickRow
                key={`quick-${node.id}`}
                node={node}
                last={i === quickNodes.length - 1 && routeList.length === 0}
              />
            ))}
            {routeList.map((route, i) => (
              <RouteRow
                key={route.id}
                route={route}
                nodeName={nodeName.get(route.nodeId) ?? '—'}
                last={i === routeList.length - 1}
              />
            ))}
          </div>
        </Card>
      )}

      {open && (
        <CreateRouteDialog
          open
          onClose={() => setOpen(false)}
          nodes={nodes.data ?? []}
          zones={zones.data ?? []}
        />
      )}
    </div>
  );
}

function QuickRow({ node, last }: { node: PuenteNode; last: boolean }) {
  const { connector, removeQuick } = useNodeMutations();
  const quick = node.quickTunnel;
  const busy = connector.isPending || removeQuick.isPending;
  const running = quick.state === 'running' || quick.state === 'starting';
  const url = quick.state === 'running' ? quick.url : null;

  return (
    <div
      className={cn(
        'flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-muted/40',
        !last && 'border-b',
      )}
    >
      <div className="flex min-w-0 grow flex-col">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 font-semibold text-primary hover:underline"
          >
            <span className="truncate">{url.replace(/^https?:\/\//, '')}</span>
            <ExternalLink className="size-3.5 shrink-0" />
          </a>
        ) : (
          <span className="truncate font-semibold">Temporary URL</span>
        )}
        <span className="truncate font-mono text-xs text-muted-foreground">
          → {quick.origin ?? 'no origin'}
          {quick.lastError && quick.state !== 'running' ? `  ·  ${quick.lastError}` : ''}
        </span>
      </div>

      <Badge variant="muted" className="hidden sm:inline-flex">
        {node.name}
      </Badge>
      <Badge variant="muted" className="hidden sm:inline-flex">
        Temporary
      </Badge>
      <StatusBadge meta={quickStateMeta(quick.state)} title={quick.lastError ?? undefined} />

      <div className="flex items-center gap-1">
        {running ? (
          <Button
            size="icon-sm"
            variant="ghost"
            loading={busy}
            onClick={() => connector.mutate({ id: node.id, action: 'stop', type: 'quick' })}
            title="Stop Temporary URL"
          >
            {!busy && <Square className="size-3.5" />}
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            loading={busy}
            disabled={!quick.origin}
            onClick={() =>
              connector.mutate({
                id: node.id,
                action: 'start',
                type: 'quick',
                origin: quick.origin ?? undefined,
              })
            }
            title="Start Temporary URL"
          >
            {!busy && <Play className="size-3.5" />}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          loading={busy}
          disabled={!running}
          onClick={() => connector.mutate({ id: node.id, action: 'restart', type: 'quick' })}
          title="Restart Temporary URL"
        >
          {!busy && <RotateCw className="size-3.5" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          loading={busy}
          onClick={() => removeQuick.mutate(node.id)}
          title="Remove Temporary URL"
        >
          {!busy && <Trash2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function RouteRow({
  route,
  nodeName,
  last,
}: {
  route: PuenteRoute;
  nodeName: string;
  last: boolean;
}) {
  const { remove, check, update } = useRouteMutations();
  const url = `https://${route.hostname}`;
  const toggling =
    update.isPending && update.variables?.id === route.id && update.variables.input.enabled != null;
  const enabled = route.enabled;

  return (
    <div
      className={cn(
        'flex items-center gap-3.5 px-5 py-3.5 transition-colors hover:bg-muted/40',
        !last && 'border-b',
      )}
    >
      <div className="flex min-w-0 grow flex-col">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 font-semibold text-primary hover:underline"
        >
          <span className="truncate">{route.hostname}</span>
          <ExternalLink className="size-3.5" />
        </a>
        <span className="truncate font-mono text-xs text-muted-foreground">
          → {buildServiceUrl(route.service)}
          {route.path ? `  ·  ${route.path}` : ''}
        </span>
      </div>

      <Badge variant="muted" className="hidden sm:inline-flex">
        {nodeName}
      </Badge>
      <StatusBadge meta={routeStatusMeta(route.status)} dot className="hidden sm:inline-flex" />
      <StatusBadge meta={routeHealthMeta(route.health)} title={route.lastError ?? undefined} />

      <div className="flex items-center gap-1">
        {enabled ? (
          <Button
            size="icon-sm"
            variant="ghost"
            loading={toggling}
            onClick={() => update.mutate({ id: route.id, input: { enabled: false } })}
            title="Stop route (remove from tunnel, keep DNS)"
          >
            {!toggling && <Square className="size-3.5" />}
          </Button>
        ) : (
          <Button
            size="icon-sm"
            variant="ghost"
            loading={toggling}
            onClick={() => update.mutate({ id: route.id, input: { enabled: true } })}
            title="Start route"
          >
            {!toggling && <Play className="size-3.5" />}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          loading={check.isPending && check.variables === route.id}
          disabled={!enabled}
          onClick={() => check.mutate(route.id)}
          title="Check health"
        >
          {!(check.isPending && check.variables === route.id) && (
            <HeartPulse className="size-3.5" />
          )}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground hover:text-destructive"
          loading={remove.isPending && remove.variables === route.id}
          onClick={() => remove.mutate(route.id)}
          title="Delete route"
        >
          {!(remove.isPending && remove.variables === route.id) && <Trash2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
