import { describe, expect, it, vi } from 'vitest';
import type { DaemonState, StopResult } from './daemon';
import { stopForRestart } from './cli-restart';

const previous: DaemonState = {
  pid: 123,
  port: 5006,
  host: '127.0.0.1',
  url: 'http://localhost:5006',
  startedAt: new Date().toISOString(),
};

describe('stopForRestart', () => {
  it('validates an explicit port before stopping the running daemon', async () => {
    const stop = vi.fn<() => Promise<StopResult>>();
    await expect(stopForRestart({ port: 'bad' }, previous, process.cwd(), stop)).rejects.toThrow(
      /invalid port/i,
    );
    expect(stop).not.toHaveBeenCalled();
  });
});
