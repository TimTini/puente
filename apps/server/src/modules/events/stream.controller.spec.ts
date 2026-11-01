import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../common/event-bus.service';
import { StreamController } from './stream.controller';

describe('StreamController', () => {
  afterEach(() => vi.useRealTimers());

  it('completes open SSE streams and clears heartbeat intervals on module shutdown', () => {
    vi.useFakeTimers();
    const bus = new EventBus();
    const controller = new StreamController(bus);
    const received: unknown[] = [];
    let completed = false;

    controller.stream().subscribe({
      next: (event) => received.push(event),
      complete: () => {
        completed = true;
      },
    });
    expect(received).toHaveLength(1); // synchronous hello

    controller.onModuleDestroy();

    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    bus.progress('node:n1', 'done', 'finished');
    vi.advanceTimersByTime(25_000);
    expect(received).toHaveLength(1);
  });
});
