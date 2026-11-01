import { resolvePort } from './config/port-registry';
import { stopDaemon, type DaemonState, type StopResult } from './daemon';

export async function stopForRestart(
  options: { port?: string; host?: string },
  previous: DaemonState | null,
  baseDirectory: string,
  stop: () => Promise<StopResult> = stopDaemon,
): Promise<{ port: number; host: string; result: StopResult }> {
  const port =
    options.port === undefined
      ? (previous?.port ?? resolvePort('Puente dashboard', 5006, baseDirectory))
      : resolvePort('Puente dashboard', 5006, baseDirectory, process.env, Number(options.port));
  const host = options.host ?? previous?.host ?? '0.0.0.0';
  const result = await stop();
  return { port, host, result };
}
