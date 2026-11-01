import { useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Globe } from 'lucide-react';
import {
  buildServiceUrl,
  computeHostname,
  type CloudflareZone,
  type CreateRouteInput,
  type Node as PuenteNode,
  type ServiceProtocol,
} from '@puente/shared';
import { useNodeMutations, useRouteMutations } from '../lib/hooks';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Field } from './ui/extras';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { cn } from '@/lib/utils';

const PROTOCOLS: ServiceProtocol[] = ['http', 'https', 'tcp', 'ssh', 'rdp'];
/** Sentinel in the Domain select — starts a Quick Tunnel instead of a named route. */
const TEMPORARY_URL = '__temporary_url__';

export function CreateRouteDialog({
  open,
  onClose,
  nodes,
  zones,
  defaultNodeId,
  defaultZoneId,
}: {
  open: boolean;
  onClose: () => void;
  nodes: PuenteNode[];
  zones: CloudflareZone[];
  defaultNodeId?: string;
  defaultZoneId?: string | null;
}) {
  const provisioned = nodes.filter((n) => n.tunnelId);
  const selectableNodes = (temporaryMode: boolean) =>
    temporaryMode ? nodes : provisioned;
  const [nodeId, setNodeId] = useState(defaultNodeId ?? nodes[0]?.id ?? '');
  const [zoneId, setZoneId] = useState(defaultZoneId ?? zones[0]?.id ?? TEMPORARY_URL);
  const [subdomain, setSubdomain] = useState('');
  const [protocol, setProtocol] = useState<ServiceProtocol>('http');
  const [host, setHost] = useState('localhost');
  const [port, setPort] = useState('');
  const [path, setPath] = useState('');
  const [noTLSVerify, setNoTLSVerify] = useState(false);
  const [httpHostHeader, setHttpHostHeader] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const { create } = useRouteMutations();
  const { connector } = useNodeMutations();

  const temporary = zoneId === TEMPORARY_URL;
  const nodeOptions = selectableNodes(temporary);
  const zone = zones.find((z) => z.id === zoneId);
  const hostname = useMemo(
    () => (zone ? computeHostname(subdomain || 'sub', zone.name) : ''),
    [subdomain, zone],
  );
  const serviceUrl = useMemo(
    () => buildServiceUrl({ protocol, host, port: Number(port) || 0 }),
    [protocol, host, port],
  );
  const httpCompatible = protocol === 'http' || protocol === 'https';

  const submit = () => {
    if (temporary) {
      connector.mutate(
        { id: nodeId, action: 'start', type: 'quick', origin: serviceUrl },
        {
          onSuccess: () => {
            setPort('');
            onClose();
          },
        },
      );
      return;
    }
    const input: CreateRouteInput = {
      nodeId,
      zoneId,
      subdomain: subdomain.trim(),
      service: { protocol, host: host.trim() || 'localhost', port: Number(port) },
      enabled: true,
      ...(path.trim() ? { path: path.trim() } : {}),
      ...(noTLSVerify || httpHostHeader.trim()
        ? {
            originRequest: {
              ...(noTLSVerify ? { noTLSVerify: true } : {}),
              ...(httpHostHeader.trim() ? { httpHostHeader: httpHostHeader.trim() } : {}),
            },
          }
        : {}),
    };
    create.mutate(input, {
      onSuccess: () => {
        setSubdomain('');
        setPort('');
        setPath('');
        onClose();
      },
    });
  };

  const canSubmit = temporary
    ? Boolean(nodeId && Number(port) > 0 && httpCompatible)
    : Boolean(nodeId && zoneId && subdomain.trim() && Number(port) > 0);
  const busy = temporary ? connector.isPending : create.isPending;

  if (nodes.length === 0) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish a route</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Add a node before publishing a temporary URL or a custom domain route.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!temporary && provisioned.length === 0) {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Publish a route</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Provision a named tunnel before publishing a custom domain, or choose Temporary URL in
            Domain.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setZoneId(TEMPORARY_URL)}>
              Use Temporary URL
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish a route</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Node" hint="Where the service runs.">
              <Select value={nodeId} onValueChange={setNodeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  {nodeOptions.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Domain">
              <Select
                value={zoneId}
                onValueChange={(value) => {
                  setZoneId(value);
                  if (value === TEMPORARY_URL) {
                    const stillValid = nodes.some((n) => n.id === nodeId);
                    if (!stillValid) setNodeId(nodes[0]?.id ?? '');
                  } else if (!provisioned.some((n) => n.id === nodeId)) {
                    setNodeId(provisioned[0]?.id ?? nodeId);
                  }
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a domain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={TEMPORARY_URL}>Temporary URL</SelectItem>
                  {zones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {!temporary && (
            <Field label="Subdomain" hint="Use @ to publish on the domain root." htmlFor="subdomain">
              <div className="flex">
                <Input
                  id="subdomain"
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                  placeholder="vw"
                  autoFocus
                  className="rounded-r-none"
                />
                <span className="inline-flex items-center whitespace-nowrap rounded-r-md border border-l-0 border-input bg-muted px-3 text-sm text-muted-foreground">
                  .{zone?.name ?? 'example.com'}
                </span>
              </div>
            </Field>
          )}

          {temporary && (
            <p className="text-sm text-muted-foreground">
              Creates a trycloudflare.com link for this service. No Cloudflare domain needed. Only
              HTTP and HTTPS origins are supported.
            </p>
          )}

          <div className="grid gap-3" style={{ gridTemplateColumns: '120px 1fr 100px' }}>
            <Field label="Protocol">
              <Select value={protocol} onValueChange={(v) => setProtocol(v as ServiceProtocol)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROTOCOLS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Service host" htmlFor="svc-host">
              <Input
                id="svc-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="localhost"
              />
            </Field>
            <Field label="Port" htmlFor="svc-port">
              <Input
                id="svc-port"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="7008"
                inputMode="numeric"
              />
            </Field>
          </div>

          {!temporary && (
            <div>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={() => setAdvanced((a) => !a)}
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', advanced && 'rotate-180')}
                />
                Advanced options
              </Button>
            </div>
          )}

          {!temporary && advanced && (
            <div className="flex flex-col gap-3 rounded-xl bg-muted/60 p-4">
              <Field
                label="Path (regex)"
                hint="Optional. Route only requests matching this path."
                htmlFor="path"
              >
                <Input
                  id="path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/api/.*"
                />
              </Field>
              <Field
                label="HTTP Host header"
                hint="Optional. Override the Host header sent to the origin."
                htmlFor="host-header"
              >
                <Input
                  id="host-header"
                  value={httpHostHeader}
                  onChange={(e) => setHttpHostHeader(e.target.value)}
                  placeholder="internal.local"
                />
              </Field>
              <div className="flex items-center justify-between gap-4">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">Skip origin TLS verification</span>
                  <span className="text-xs text-muted-foreground">
                    Enable for self-signed HTTPS origins.
                  </span>
                </div>
                <Switch checked={noTLSVerify} onCheckedChange={setNoTLSVerify} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/10 p-4 font-mono text-sm">
            <span className="flex items-center gap-1.5 font-semibold text-primary">
              <Globe className="size-4" />
              {temporary ? 'Temporary URL' : hostname || 'sub.example.com'}
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
            <span>{serviceUrl}</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            {temporary ? 'Start Temporary URL' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
