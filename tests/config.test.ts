import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configPath, readConfig, writeConfig } from '../src/main/config';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'supp-config-'));
  process.env.SUPPORT_CONFIG_DIR = directory;
});
afterEach(async () => {
  delete process.env.SUPPORT_CONFIG_DIR;
  await rm(directory, { recursive: true, force: true });
});

const file = () => path.join(directory, 'config.json');

describe('workspace config', () => {
  it('returns defaults when the file is absent', async () => {
    await expect(readConfig()).resolves.toEqual({
      config: { chatSide: 'left', filesSide: 'right', filesHidden: false }, error: null,
    });
  });

  it('merges partial values with defaults', async () => {
    await writeFile(file(), JSON.stringify({ chatSide: 'right' }));
    const result = await readConfig();
    expect(result.config).toEqual({ chatSide: 'right', filesSide: 'right', filesHidden: false });
    expect(result.error).toBeNull();
  });

  it('reports an unknown value, keeps defaults and leaves the file untouched', async () => {
    const raw = JSON.stringify({ chatSide: 'middle' });
    await writeFile(file(), raw);
    const result = await readConfig();
    expect(result.config).toEqual({ chatSide: 'left', filesSide: 'right', filesHidden: false });
    expect(result.error).toContain(configPath());
    expect(await readFile(file(), 'utf8')).toBe(raw);
  });

  it('reports malformed JSON the same way', async () => {
    await writeFile(file(), '{ nope');
    const result = await readConfig();
    expect(result.error).toContain(configPath());
    expect(await readFile(file(), 'utf8')).toBe('{ nope');
  });

  it('writes all keys and preserves unknown keys', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(file(), JSON.stringify({ chatSide: 'right', future: { keep: true } }));
    await writeConfig({ filesHidden: true });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      chatSide: 'right', filesSide: 'right', filesHidden: true, future: { keep: true },
    });
    await expect(readConfig()).resolves.toMatchObject({ config: { filesHidden: true }, error: null });
  });

  it('refuses to write over a malformed file', async () => {
    await writeFile(file(), '{ nope');
    await expect(writeConfig({ chatSide: 'right' })).rejects.toMatchObject({ code: 'STATE' });
    expect(await readFile(file(), 'utf8')).toBe('{ nope');
  });

  it('names the config path in write and parse errors', async () => {
    await writeFile(file(), '{ nope');
    await expect(writeConfig({ chatSide: 'right' })).rejects.toMatchObject({ message: expect.stringContaining(configPath()) });
    const result = await readConfig();
    expect(result.error).toContain(configPath());
    expect(result.error?.split(configPath())).toHaveLength(2);
  });

  it('treats a literal null file as invalid rather than absent', async () => {
    await writeFile(file(), 'null');
    const result = await readConfig();
    expect(result.error).toContain(configPath());
    await expect(writeConfig({ chatSide: 'right' })).rejects.toMatchObject({ code: 'STATE' });
    expect(await readFile(file(), 'utf8')).toBe('null');
  });

  it('creates the directory on first write', async () => {
    const nested = path.join(directory, 'nested');
    process.env.SUPPORT_CONFIG_DIR = nested;
    await expect(writeConfig({ chatSide: 'right' })).resolves.toMatchObject({ chatSide: 'right' });
    expect(JSON.parse(await readFile(path.join(nested, 'config.json'), 'utf8')).chatSide).toBe('right');
  });
});
