import path from 'node:path';

import type { PluginManifest } from './types';

const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/** Plugin ids double as directory names and action prefixes, and action names follow the same rule. */
export function isValidPluginName(id: string): boolean {
  return PLUGIN_NAME_PATTERN.test(id);
}

/** Validates parsed `plugin.json` content. Returns an error message instead of throwing. */
export function parsePluginManifest(
  raw: unknown,
  fallbackName: string,
): { manifest: PluginManifest } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'plugin.json must contain a JSON object.' };
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.main !== 'string' || value.main.trim().length === 0) {
    return { error: 'plugin.json needs a "main" entry file.' };
  }
  if (value.name !== undefined && typeof value.name !== 'string') {
    return { error: 'plugin.json "name" must be a string.' };
  }
  if (value.version !== undefined && typeof value.version !== 'string') {
    return { error: 'plugin.json "version" must be a string.' };
  }
  return {
    manifest: {
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fallbackName,
      version: typeof value.version === 'string' ? value.version : null,
      main: value.main.trim(),
    },
  };
}

/** Resolves the entry file, rejecting paths that leave the plugin directory. */
export function resolvePluginEntryPath(pluginDir: string, main: string): string | null {
  const resolved = path.resolve(pluginDir, main);
  const relative = path.relative(pluginDir, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}
