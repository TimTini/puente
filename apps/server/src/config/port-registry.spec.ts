import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePort } from './port-registry';

const tempDirs: string[] = [];

function registryFile(ports: unknown): { baseDirectory: string; registryPath: string } {
  const tempRoot = join(process.cwd(), '.puente', 'port-registry-test-data');
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, 'case-'));
  tempDirs.push(root);
  const baseDirectory = join(root, 'MyGitProject', 'puente', 'apps', 'server', 'src');
  const registryDirectory = join(root, 'MyGitProject', 'port-registry');
  mkdirSync(baseDirectory, { recursive: true });
  mkdirSync(registryDirectory, { recursive: true });
  const registryPath = join(registryDirectory, 'ports.json');
  writeFileSync(registryPath, JSON.stringify({ ports }));
  return { baseDirectory, registryPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolvePort', () => {
  it('uses the port registered for the requested role', () => {
    const { baseDirectory } = registryFile([
      { repo: 'puente', port: 5006, note: 'Puente dashboard' },
      { repo: 'puente', port: 5173, note: 'Puente web dev' },
    ]);
    expect(resolvePort('Puente web dev', 5173, baseDirectory, {})).toBe(5173);
  });

  it('supports an explicit registry path for published installs', () => {
    const { registryPath } = registryFile([
      { repo: 'puente', port: 6006, note: 'Puente dashboard' },
    ]);
    expect(
      resolvePort('Puente dashboard', 5006, 'C:/installed/puente', {
        PUENTE_PORT_REGISTRY: registryPath,
      }),
    ).toBe(6006);
    expect(() =>
      resolvePort('Puente dashboard', 5006, 'C:/installed/puente', {
        PUENTE_PORT_REGISTRY: `${registryPath}.missing`,
      }),
    ).toThrow(/not found/i);
  });

  it('preserves explicit CLI and environment precedence', () => {
    const { baseDirectory, registryPath } = registryFile([
      { repo: 'puente', port: 5006, note: 'Puente dashboard' },
    ]);
    writeFileSync(registryPath, '{');
    expect(resolvePort('Puente dashboard', 5006, baseDirectory, {}, 6000)).toBe(6000);
    expect(resolvePort('Puente dashboard', 5006, baseDirectory, { PORT: '6001' })).toBe(6001);
    expect(
      resolvePort('Puente dashboard', 5006, baseDirectory, { PUENTE_PORT: '6002', PORT: '6001' }),
    ).toBe(6002);
  });

  it('falls back when the registry is absent or has no matching role', () => {
    const tempRoot = join(process.cwd(), '.puente', 'port-registry-test-data');
    mkdirSync(tempRoot, { recursive: true });
    const root = mkdtempSync(join(tempRoot, 'case-'));
    tempDirs.push(root);
    expect(resolvePort('Puente dashboard', 5006, root, {})).toBe(5006);
    const { baseDirectory } = registryFile([{ repo: 'other', port: 6000, note: '' }]);
    expect(resolvePort('Puente dashboard', 5006, baseDirectory, {})).toBe(5006);
  });

  it('does not use an unregistered fallback owned by another repo', () => {
    const { baseDirectory } = registryFile([{ repo: 'other', port: 5006, note: 'service' }]);
    expect(() => resolvePort('Puente dashboard', 5006, baseDirectory, {})).toThrow(
      /fallback port 5006 is registered to other/i,
    );
  });

  it('rejects malformed and conflicting registries instead of falling back', () => {
    const { registryPath, baseDirectory } = registryFile([]);
    writeFileSync(registryPath, '{');
    expect(() => resolvePort('Puente dashboard', 5006, baseDirectory, {})).toThrow(/invalid JSON/i);
    writeFileSync(
      registryPath,
      JSON.stringify({
        ports: [
          { repo: 'puente', port: 5006, note: 'Puente dashboard' },
          { repo: 'another', port: 5006, note: '' },
        ],
      }),
    );
    expect(() => resolvePort('Puente dashboard', 5006, baseDirectory, {})).toThrow(
      /duplicate port/i,
    );
  });

  it('rejects ambiguous matching role rows', () => {
    const { baseDirectory } = registryFile([
      { repo: 'puente', port: 5006, note: 'Puente dashboard' },
      { repo: 'puente', port: 5007, note: 'Puente dashboard' },
    ]);
    expect(() => resolvePort('Puente dashboard', 5006, baseDirectory, {})).toThrow(
      /multiple.*Puente dashboard/i,
    );
  });
});
