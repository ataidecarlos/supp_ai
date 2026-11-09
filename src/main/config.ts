import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../shared/config';
import { atomicJson, WorkspaceError } from './files';

export function configPath(): string {
  return path.join(process.env.SUPPORT_CONFIG_DIR || path.join(homedir(), '.suppai'), 'config.json');
}

function side(record: Record<string, unknown>, key: 'chatSide' | 'filesSide'): 'left' | 'right' {
  const value = record[key];
  if (value === undefined) return DEFAULT_CONFIG[key];
  if (value === 'left' || value === 'right') return value;
  throw new WorkspaceError('STATE', `Set "${key}" to "left" or "right" in ${configPath()}.`);
}

export function parseConfig(value: unknown): Config {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError('STATE', `Configuration at ${configPath()} must be a JSON object.`);
  }
  const record = value as Record<string, unknown>;
  const hidden = record.filesHidden;
  if (hidden !== undefined && typeof hidden !== 'boolean') {
    throw new WorkspaceError('STATE', `Set "filesHidden" to true or false in ${configPath()}.`);
  }
  return { chatSide: side(record, 'chatSide'), filesSide: side(record, 'filesSide'), filesHidden: hidden ?? DEFAULT_CONFIG.filesHidden };
}

async function readRaw(): Promise<unknown | undefined> {
  let source: string;
  try { source = await readFile(configPath(), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new WorkspaceError('STATE', `Cannot read ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try { return JSON.parse(source) as unknown; }
  catch (error) {
    throw new WorkspaceError('STATE', `Cannot parse ${configPath()}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readConfig(): Promise<{ config: Config; error: string | null }> {
  try {
    const stored = await readRaw();
    return { config: stored === undefined ? { ...DEFAULT_CONFIG } : parseConfig(stored), error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      error: detail.includes(configPath()) ? detail : `Configuration at ${configPath()} is invalid: ${detail}`,
    };
  }
}

export async function writeConfig(patch: Partial<Config>): Promise<Config> {
  const stored = await readRaw();
  if (stored !== undefined && (typeof stored !== 'object' || stored === null || Array.isArray(stored))) {
    throw new WorkspaceError('STATE', `Configuration at ${configPath()} must be a JSON object.`);
  }
  const raw = (stored ?? {}) as Record<string, unknown>;
  const config = parseConfig({ ...raw, ...patch });
  await atomicJson(configPath(), { ...raw, ...config });
  return config;
}
