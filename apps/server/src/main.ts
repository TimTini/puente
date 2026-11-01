import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ensureDataDir } from './config/paths';
import { resolvePort } from './config/port-registry';

export interface ServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/** Boot the NestJS control-plane server. Returns a handle for graceful shutdown. */
export async function bootstrap(opts: { port: number; host?: string }): Promise<ServerHandle> {
  ensureDataDir();
  const app = await NestFactory.create(AppModule, { cors: true });
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const host = opts.host ?? '0.0.0.0';
  await app.listen(opts.port, host);
  return {
    url: `http://localhost:${opts.port}`,
    port: opts.port,
    close: () => app.close(),
  };
}

if (require.main === module) {
  const port = resolvePort('Puente dashboard', 5006, __dirname);
  bootstrap({ port }).then((handle) => {
    console.log(`puente server listening on ${handle.url}`);
  });
}
