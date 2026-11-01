import { Controller, Sse, MessageEvent, OnModuleDestroy } from '@nestjs/common';
import { interval, map, merge, of, Observable, Subject, takeUntil } from 'rxjs';
import type { StreamEvent } from '@puente/shared';
import { EventBus } from '../../common/event-bus.service';

@Controller('stream')
export class StreamController implements OnModuleDestroy {
  private readonly destroy$ = new Subject<void>();

  constructor(private readonly bus: EventBus) {}

  onModuleDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** Single SSE channel the SPA subscribes to for all live updates. */
  @Sse()
  stream(): Observable<MessageEvent> {
    const now = () => new Date().toISOString();
    const hello$ = of<StreamEvent>({ type: 'hello', at: now() });
    const ping$ = interval(25000).pipe(
      map<number, StreamEvent>(() => ({ type: 'ping', at: now() })),
    );
    const events$ = this.bus.stream$;
    return merge(hello$, events$, ping$).pipe(
      takeUntil(this.destroy$),
      map((e) => ({ data: e }) as MessageEvent),
    );
  }
}
