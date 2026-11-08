import { homedir } from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../shared/config';
import { atomicJson, optionalJson, WorkspaceError } from './files';

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

export async function readConfig(): Promise<{ config: Config; error: string | null }> {
  try {
    const stored = await optionalJson(configPath());
    return { config: stored === null ? { ...DEFAULT_CONFIG } : parseConfig(stored), error: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: { ...DEFAULT_CONFIG }, error: `Configuration at ${configPath()} is invalid: ${detail}` };
  }
}

export async function writeConfig(patch: Partial<Config>): Promise<Config> {
  const stored = await optionalJson(configPath());
  if (stored !== null && (typeof stored !== 'object' || Array.isArray(stored))) {
    throw new WorkspaceError('STATE', `Configuration at ${configPath()} must be a JSON object.`);
  }
  const raw = (stored ?? {}) as Record<string, unknown>;
  const config = parseConfig({ ...raw, ...patch });
  await atomicJson(configPath(), { ...raw, ...config });
  return config;
}
