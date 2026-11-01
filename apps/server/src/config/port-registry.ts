import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type PortEntry = { repo: string; port: number; note: string };

function registryPath(baseDirectory: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.PUENTE_PORT_REGISTRY) return resolve(env.PUENTE_PORT_REGISTRY);
  let directory = resolve(baseDirectory);
  while (true) {
    if (basename(directory) === 'MyGitProject')
      return join(directory, 'port-registry', 'ports.json');
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readEntries(path: string): PortEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Port registry ${path} contains invalid JSON: ${String(error)}`, {
      cause: error,
    });
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as { ports?: unknown }).ports)) {
    throw new Error(`Port registry ${path} must contain a ports array`);
  }
  const entries = (data as { ports: unknown[] }).ports;
  const usedPorts = new Set<number>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as PortEntry).repo !== 'string' ||
      !(entry as PortEntry).repo.trim() ||
      typeof (entry as PortEntry).note !== 'string' ||
      (entry as PortEntry).note.includes('\n') ||
      !Number.isInteger((entry as PortEntry).port) ||
      (entry as PortEntry).port < 1 ||
      (entry as PortEntry).port > 65535
    ) {
      throw new Error(`Port registry ${path} contains an invalid entry`);
    }
    const port = (entry as PortEntry).port;
    if (usedPorts.has(port))
      throw new Error(`Port registry ${path} contains duplicate port ${port}`);
    usedPorts.add(port);
  }
  return entries as PortEntry[];
}

export function getRegisteredPort(
  role: string,
  fallback: number,
  baseDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const path = registryPath(baseDirectory, env);
  if (!path) return fallback;
  if (!existsSync(path)) {
    if (env.PUENTE_PORT_REGISTRY) throw new Error(`Port registry not found: ${path}`);
    return fallback;
  }
  const entries = readEntries(path);
  const matches = entries.filter((entry) => entry.repo === 'puente' && entry.note === role);
  if (matches.length > 1)
    throw new Error(`Port registry has multiple entries for puente role "${role}"`);
  if (!matches.length) {
    const fallbackOwner = entries.find((entry) => entry.port === fallback);
    if (fallbackOwner && (fallbackOwner.repo !== 'puente' || fallbackOwner.note !== role)) {
      throw new Error(
        `Fallback port ${fallback} is registered to ${fallbackOwner.repo} (${fallbackOwner.note})`,
      );
    }
  }
  return matches[0]?.port ?? fallback;
}

export function resolvePort(
  role: string,
  fallback: number,
  baseDirectory: string,
  env: NodeJS.ProcessEnv = process.env,
  explicitPort?: number,
): number {
  if (explicitPort !== undefined) {
    if (!Number.isInteger(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
      throw new Error(`Invalid port: ${explicitPort}`);
    }
    return explicitPort;
  }
  const value = env.PUENTE_PORT || env.PORT;
  if (value !== undefined) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in ${env.PUENTE_PORT ? 'PUENTE_PORT' : 'PORT'}: ${value}`);
    }
    return port;
  }
  return getRegisteredPort(role, fallback, baseDirectory, env);
}
