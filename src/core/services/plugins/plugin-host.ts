import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { BrowserWindow } from 'electron';

import type { SessionActionDispatchRequest } from '../../../types/runtime';
import { execPluginCommand } from './exec';
import { isValidPluginName, parsePluginManifest, resolvePluginFilePath } from './manifest';
import {
  PLUGIN_MPV_EVENT_NAMES,
  type PluginAnkiEventMap,
  type PluginAnkiEventName,
  type PluginAnkiInvokeOptions,
  type PluginConfigEntry,
  type PluginContext,
  type PluginLogger,
  type PluginModule,
  type PluginMpvEventName,
  type PluginNotifyVariant,
  type PluginPanelContent,
  type PluginPanelHandle,
  type PluginSubtitleContext,
  type PluginSubtitleLine,
  type PluginWindowRequest,
} from './types';

const MIN_TIMER_INTERVAL_MS = 100;
const DEFAULT_WINDOW_WIDTH = 960;
const DEFAULT_WINDOW_HEIGHT = 720;
/**
 * Quit waits for unloadAll, so a load or deactivate that never settles must not hold the app open.
 * The forced-exit fallback in main adds its own budget on top of this.
 */
export const PLUGIN_DEACTIVATE_TIMEOUT_MS = 2_000;

interface MpvClientEvents {
  on: (event: PluginMpvEventName, listener: (payload: unknown) => void) => void;
  off: (event: PluginMpvEventName, listener: (payload: unknown) => void) => void;
}

export interface PluginHostDeps<TUnstable> {
  pluginsDir: string;
  /** Root of the per-plugin data folders; each plugin gets `<pluginDataDir>/<id>`. */
  pluginDataDir: string;
  getPluginConfig: () => Record<string, PluginConfigEntry>;
  createLogger: (scope: string) => PluginLogger;
  isMpvConnected: () => boolean;
  sendMpvCommand: (command: (string | number)[]) => void;
  requestMpvProperty: (name: string) => Promise<unknown>;
  ensureMpvRunning: () => Promise<boolean>;
  invokeAnkiConnect: (
    action: string,
    params: Record<string, unknown>,
    options: PluginAnkiInvokeOptions,
  ) => Promise<unknown>;
  dispatchSessionAction: (request: SessionActionDispatchRequest) => Promise<void>;
  getCurrentSubtitle: () => PluginSubtitleLine | null;
  getSubtitleContext: (options: { before?: number; after?: number }) => PluginSubtitleContext;
  notify: (message: string, variant: PluginNotifyVariant) => void;
  openPanel: (content: PluginPanelContent) => PluginPanelHandle;
  /** Focuses the window already open under `request.key`, or creates it (`created: true`). */
  openWindow: (request: PluginWindowRequest) => { window: BrowserWindow; created: boolean };
  unstable: TUnstable;
  /** Test seam; defaults to Node's `require`, which also loads synchronous ES modules. */
  loadModule?: (entryPath: string) => PluginModule;
  exec?: typeof execPluginCommand;
  /** How long unload waits, in total, for loading and deactivate before disposing anyway. */
  deactivateTimeoutMs?: number;
}

interface LoadedPlugin {
  id: string;
  disposers: Set<() => void>;
  deactivate: (() => unknown) | null;
  /** Aborted on unload so in-flight `exec` children die with the plugin. */
  lifetime: AbortController;
}

/** Resolves when `promise` settles, or rejects once `timeoutMs` passes first. */
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function pickExport<K extends 'activate' | 'deactivate'>(
  mod: PluginModule,
  key: K,
): NonNullable<PluginModule[K]> | null {
  const direct = mod[key];
  if (typeof direct === 'function') return direct as NonNullable<PluginModule[K]>;
  const fromDefault = mod.default?.[key];
  return typeof fromDefault === 'function' ? (fromDefault as NonNullable<PluginModule[K]>) : null;
}

/**
 * Loads enabled plugins from `<pluginsDir>/<id>/plugin.json` and gives each one a scoped context.
 * Every plugin callback runs behind a guard, so a throwing plugin logs instead of breaking the app.
 * Plugins run in the main process: a synchronous busy loop still blocks it.
 */
export function createPluginHost<TUnstable>(deps: PluginHostDeps<TUnstable>) {
  const mpvEvents = new EventEmitter();
  mpvEvents.setMaxListeners(0);
  const ankiEvents = new EventEmitter();
  ankiEvents.setMaxListeners(0);
  const plugins = new Map<string, LoadedPlugin>();
  const actions = new Map<string, { pluginId: string; handler: () => unknown }>();
  const loadModule = deps.loadModule ?? ((entryPath: string) => require(entryPath) as PluginModule);
  const exec = deps.exec ?? execPluginCommand;
  let attachedClient: {
    client: MpvClientEvents;
    forwarders: Map<string, (p: unknown) => void>;
  } | null = null;
  let loadPromise: Promise<void> | null = null;
  // Set once unloadAll has picked the plugins to unload; anything that activates later cleans up itself.
  let unloaded = false;

  function runGuarded(log: PluginLogger, label: string, callback: () => unknown): void {
    try {
      const result = callback();
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((error) =>
          log.error(`${label} failed: ${errorMessage(error)}`),
        );
      }
    } catch (error) {
      log.error(`${label} failed: ${errorMessage(error)}`);
    }
  }

  function createContext(
    plugin: LoadedPlugin,
    dir: string,
    dataDir: string,
    entry: PluginConfigEntry,
    log: PluginLogger,
  ): PluginContext<TUnstable> {
    const track = (dispose: () => void): (() => void) => {
      let disposed = false;
      const disposer = (): void => {
        if (disposed) return;
        disposed = true;
        plugin.disposers.delete(disposer);
        dispose();
      };
      plugin.disposers.add(disposer);
      return disposer;
    };

    return {
      id: plugin.id,
      dir,
      settings: Object.freeze({ ...entry.settings }),
      dataDir,
      log,
      every: (intervalMs, callback) => {
        const handle = setInterval(
          () => runGuarded(log, 'Timer', callback),
          Math.max(MIN_TIMER_INTERVAL_MS, intervalMs),
        );
        return track(() => clearInterval(handle));
      },
      after: (delayMs, callback) => {
        const handle = setTimeout(
          () => {
            dispose();
            runGuarded(log, 'Timer', callback);
          },
          Math.max(0, delayMs),
        );
        const dispose = track(() => clearTimeout(handle));
        return dispose;
      },
      mpv: {
        get connected() {
          return deps.isMpvConnected();
        },
        on: (event, listener) => {
          const wrapped = (payload: unknown): void =>
            runGuarded(log, `mpv ${event} listener`, () =>
              listener(payload as Parameters<typeof listener>[0]),
            );
          mpvEvents.on(event, wrapped);
          return track(() => mpvEvents.off(event, wrapped));
        },
        command: (command) => deps.sendMpvCommand(command),
        getProperty: (name) => deps.requestMpvProperty(name),
        ensureRunning: () => deps.ensureMpvRunning(),
      },
      anki: {
        on: (event, listener) => {
          const wrapped = (payload: unknown): void =>
            runGuarded(log, `anki ${event} listener`, () =>
              listener(payload as Parameters<typeof listener>[0]),
            );
          ankiEvents.on(event, wrapped);
          return track(() => ankiEvents.off(event, wrapped));
        },
        invoke: (action, params = {}, options = {}) =>
          deps.invokeAnkiConnect(action, params, options),
      },
      subtitles: {
        current: () => deps.getCurrentSubtitle(),
        context: (options = {}) => deps.getSubtitleContext(options),
      },
      actions: {
        register: (name, handler) => {
          if (!isValidPluginName(name)) {
            throw new Error(`Invalid action name "${name}"; use letters, digits, ".", "_" or "-".`);
          }
          const actionId = `${plugin.id}/${name}`;
          if (actions.has(actionId)) {
            throw new Error(`Action "${actionId}" is already registered.`);
          }
          actions.set(actionId, { pluginId: plugin.id, handler });
          return track(() => actions.delete(actionId));
        },
        run: (actionId, payload) =>
          deps.dispatchSessionAction(payload === undefined ? { actionId } : { actionId, payload }),
      },
      notify: (message, options) => deps.notify(message, options?.variant ?? 'info'),
      ui: {
        panel: (content) => {
          const handle = deps.openPanel({
            title: content.title ?? plugin.id,
            markdown: content.markdown,
          });
          const dispose = track(() => handle.close());
          handle.signal.addEventListener('abort', dispose, { once: true });
          return handle;
        },
        openWindow: (options) => {
          const resolveFile = (label: string, file: string): string => {
            const resolved = resolvePluginFilePath(dir, file);
            if (!resolved) throw new Error(`Window ${label} "${file}" must stay inside ${dir}.`);
            return resolved;
          };
          const htmlPath = resolveFile('html', options.html);
          const { window, created } = deps.openWindow({
            key: `${plugin.id}:${htmlPath}`,
            htmlPath,
            preloadPath:
              options.preload === undefined ? null : resolveFile('preload', options.preload),
            title: options.title ?? plugin.id,
            width: options.width ?? DEFAULT_WINDOW_WIDTH,
            height: options.height ?? DEFAULT_WINDOW_HEIGHT,
          });
          if (created) {
            let closed = false;
            const dispose = track(() => {
              if (!closed && !window.isDestroyed()) window.destroy();
            });
            window.once('closed', () => {
              closed = true;
              dispose();
            });
          }
          return window;
        },
      },
      exec: (command, args, options = {}) =>
        exec(command, args, {
          ...options,
          signal: options.signal
            ? AbortSignal.any([options.signal, plugin.lifetime.signal])
            : plugin.lifetime.signal,
        }),
      unstable: deps.unstable,
    };
  }

  function disposePlugin(plugin: LoadedPlugin): void {
    plugin.lifetime.abort();
    for (const dispose of [...plugin.disposers]) {
      try {
        dispose();
      } catch {
        // A failing disposer must not keep the rest registered.
      }
    }
    plugins.delete(plugin.id);
  }

  async function loadPlugin(id: string, entry: PluginConfigEntry): Promise<void> {
    const log = deps.createLogger(`plugin:${id}`);
    if (!isValidPluginName(id)) {
      log.error(`Invalid plugin id "${id}"; use letters, digits, ".", "_" or "-".`);
      return;
    }

    const dir = path.join(deps.pluginsDir, id);
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(await fs.readFile(path.join(dir, 'plugin.json'), 'utf8'));
    } catch (error) {
      log.error(`Cannot read ${path.join(dir, 'plugin.json')}: ${errorMessage(error)}`);
      return;
    }
    const parsed = parsePluginManifest(rawManifest, id);
    if ('error' in parsed) {
      log.error(parsed.error);
      return;
    }
    const entryPath = resolvePluginFilePath(dir, parsed.manifest.main);
    if (!entryPath) {
      log.error(`Entry "${parsed.manifest.main}" must stay inside ${dir}.`);
      return;
    }

    const dataDir = path.join(deps.pluginDataDir, id);
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      log.error(`Cannot create data folder ${dataDir}: ${errorMessage(error)}`);
      return;
    }

    const plugin: LoadedPlugin = {
      id,
      disposers: new Set(),
      deactivate: null,
      lifetime: new AbortController(),
    };
    if (unloaded) return;
    plugins.set(id, plugin);
    try {
      const mod = loadModule(entryPath);
      const activate = pickExport(mod, 'activate');
      if (!activate) {
        throw new Error(`${parsed.manifest.main} does not export an activate(ctx) function.`);
      }
      const returned = await activate(
        createContext(plugin, dir, dataDir, entry, log) as PluginContext,
      );
      plugin.deactivate =
        typeof returned === 'function'
          ? (returned as () => unknown)
          : pickExport(mod, 'deactivate');
      if (unloaded) {
        // activate outlasted unloadAll's wait, so unloadAll skipped or only half-disposed it.
        log.warn('Activated after unload started; unloading it now.');
        runGuarded(log, 'deactivate', () => plugin.deactivate?.());
        disposePlugin(plugin);
        return;
      }
      const version = parsed.manifest.version ? ` v${parsed.manifest.version}` : '';
      log.info(`Loaded ${parsed.manifest.name}${version}.`);
    } catch (error) {
      log.error(`Activation failed: ${errorMessage(error)}`);
      disposePlugin(plugin);
    }
  }

  return {
    /** Forwards the client's events to plugin listeners, replacing any previously attached client. */
    attachMpvClient(client: MpvClientEvents): void {
      if (attachedClient) {
        for (const [event, forward] of attachedClient.forwarders) {
          attachedClient.client.off(event as PluginMpvEventName, forward);
        }
      }
      const forwarders = new Map<string, (payload: unknown) => void>();
      for (const event of PLUGIN_MPV_EVENT_NAMES) {
        const forward = (payload: unknown): void => {
          mpvEvents.emit(event, payload);
        };
        client.on(event, forward);
        forwarders.set(event, forward);
      }
      attachedClient = { client, forwarders };
    },

    /** Delivers an Anki event to every plugin listening for it. */
    emitAnkiEvent<E extends PluginAnkiEventName>(event: E, payload: PluginAnkiEventMap[E]): void {
      ankiEvents.emit(event, payload);
    },

    /** Loads every enabled plugin once; later calls return the first load. */
    loadAll(): Promise<void> {
      loadPromise ??= Promise.all(
        Object.entries(deps.getPluginConfig())
          .filter(([, entry]) => entry.enabled)
          .map(([id, entry]) => loadPlugin(id, entry)),
      ).then(() => undefined);
      return loadPromise;
    },

    async unloadAll(): Promise<void> {
      // One budget covers the load wait and every deactivate, so quit is bounded by it.
      const timeoutMs = deps.deactivateTimeoutMs ?? PLUGIN_DEACTIVATE_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // Plugins still reading their files are not in `plugins` yet; let the load finish first.
      if (loadPromise) {
        try {
          await settleWithin(loadPromise, timeoutMs);
        } catch (error) {
          deps
            .createLogger('plugins')
            .warn(`Unloading before load finished: ${errorMessage(error)}`);
        }
      }
      loadPromise = null;
      unloaded = true;
      await Promise.all(
        [...plugins.values()].map(async (plugin) => {
          try {
            await settleWithin(
              Promise.resolve().then(() => plugin.deactivate?.()),
              Math.max(0, deadline - Date.now()),
            );
          } catch (error) {
            deps
              .createLogger(`plugin:${plugin.id}`)
              .error(`deactivate failed: ${errorMessage(error)}`);
          }
          disposePlugin(plugin);
        }),
      );
    },

    /**
     * Runs a registered `<plugin id>/<name>` action, waiting for an in-progress load first so a
     * command sent at startup is not lost. Resolves false when no plugin registered the action.
     */
    async runAction(actionId: string): Promise<boolean> {
      await loadPromise;
      const action = actions.get(actionId);
      if (!action) return false;
      runGuarded(
        deps.createLogger(`plugin:${action.pluginId}`),
        `Action ${actionId}`,
        action.handler,
      );
      return true;
    },
  };
}

export type PluginHost = ReturnType<typeof createPluginHost>;
