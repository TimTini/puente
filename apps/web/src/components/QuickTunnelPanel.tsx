import { useState } from 'react';
import { Copy, ExternalLink, Play, RotateCw, Square } from 'lucide-react';
import type { Node as PuenteNode } from '@puente/shared';
import { useNodeMutations } from '../lib/hooks';
import { quickStateMeta } from '../lib/status';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Field, StatusBadge } from './ui/extras';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/** One Quick Tunnel on this machine. Named tunnel controls stay on the card around it. */
export function QuickTunnelPanel({ node }: { node: PuenteNode }) {
  const m = useNodeMutations();
  const quick = node.quickTunnel;
  const originSource = `${node.id}\0${quick.origin ?? ''}`;
  const [origin, setOrigin] = useState(quick.origin ?? '');
  const [seenOrigin, setSeenOrigin] = useState(originSource);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [copied, setCopied] = useState(false);
  if (seenOrigin !== originSource) {
    setSeenOrigin(originSource);
    setOrigin(quick.origin ?? '');
  }
  const busy = m.connector.isPending;
  const locked =
    quick.state === 'running' || quick.state === 'starting' || quick.state === 'unknown';
  const showUrl = quick.state === 'running' && Boolean(quick.url);

  const start = () =>
    m.connector.mutate({ id: node.id, action: 'start', type: 'quick', origin: origin.trim() });
  const stop = () => m.connector.mutate({ id: node.id, action: 'stop', type: 'quick' });
  const restart = () => {
    setConfirmRestart(false);
    setCopied(false);
    m.connector.mutate({ id: node.id, action: 'restart', type: 'quick' });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Quick Tunnel</span>
        <StatusBadge meta={quickStateMeta(quick.state)} dot />
      </div>
      <Field label="Origin" htmlFor={`quick-origin-${node.id}`}>
        <Input
          id={`quick-origin-${node.id}`}
          value={locked ? (quick.origin ?? '') : origin}
          disabled={locked}
          placeholder="http://127.0.0.1:8080"
          onChange={(e) => setOrigin(e.target.value)}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        The node opens this address. In Docker, localhost is the container, not your browser.
      </p>
      {quick.state === 'unknown' && (
        <p className="text-xs text-warning">
          Puente cannot see this machine. The previous URL stays hidden until the tunnel is checked.
        </p>
      )}
      {quick.lastError && quick.state !== 'running' && (
        <p className="text-xs text-destructive">{quick.lastError}</p>
      )}
      {showUrl && quick.url && (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 truncate text-xs">{quick.url}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(quick.url ?? '');
              setCopied(true);
            }}
          >
            <Copy className="size-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={quick.url} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" />
              Open
            </a>
          </Button>
        </div>
      )}
      {busy && quick.state === 'starting' && (
        <p className="text-xs text-muted-foreground">
          The previous URL is cleared until the new one is ready.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {quick.state === 'running' || quick.state === 'starting' ? (
          <Button size="sm" variant="outline" loading={busy} onClick={stop}>
            {!busy && <Square className="size-3.5" />}
            Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            disabled={quick.state === 'unknown'}
            onClick={start}
          >
            {!busy && <Play className="size-3.5" />}
            Start
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={quick.state === 'unknown' || !quick.origin}
          onClick={() => (quick.state === 'running' ? setConfirmRestart(true) : restart())}
        >
          <RotateCw className="size-3.5" />
          Restart
        </Button>
      </div>

      <Dialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Restart Quick Tunnel?</DialogTitle>
            <DialogDescription>
              Restarting issues a new trycloudflare.com URL. The current one stops working.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRestart(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={restart}>
              Restart
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
