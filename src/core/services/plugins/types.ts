import type { MpvIpcClientEventMap } from '../mpv';

/** `plugin.json` at the root of a plugin directory. */
export interface PluginManifest {
  /** Display name; defaults to the directory name. */
  name: string;
  version: string | null;
  /** Entry module, relative to the plugin directory. */
  main: string;
}

/** One `plugins.<id>` entry from config. */
export interface PluginConfigEntry {
  enabled: boolean;
  settings: Record<string, unknown>;
}

/** mpv events plugins may observe. Render metrics are internal and stay hidden. */
export type PluginMpvEventMap = Omit<MpvIpcClientEventMap, 'subtitle-metrics-change'>;
export type PluginMpvEventName = keyof PluginMpvEventMap;

export const PLUGIN_MPV_EVENT_NAMES = [
  'connection-change',
  'subtitle-change',
  'subtitle-timing',
  'time-pos-change',
  'duration-change',
  'pause-change',
  'fullscreen-change',
  'secondary-subtitle-change',
  'subtitle-track-change',
  'secondary-subtitle-track-change',
  'secondary-subtitle-delay-change',
  'subtitle-track-list-change',
  'media-path-change',
  'media-title-change',
  'secondary-subtitle-visibility',
  'client-message',
] as const satisfies readonly PluginMpvEventName[];

export interface PluginSubtitleLine {
  text: string;
  /** Seconds on the subtitle file's timeline; null when mpv did not report timing. */
  startTime: number | null;
  endTime: number | null;
}

export interface PluginSubtitleContext {
  current: PluginSubtitleLine | null;
  /** Oldest first. */
  before: PluginSubtitleLine[];
  after: PluginSubtitleLine[];
}

export interface PluginPanelContent {
  title: string;
  /** Rendered as a safe markdown subset; raw HTML is shown as text. */
  markdown: string;
}

export interface PluginPanelHandle {
  /** Aborts when the user closes the panel or another panel replaces it. */
  readonly signal: AbortSignal;
  readonly closed: boolean;
  update: (content: Partial<PluginPanelContent>) => void;
  close: () => void;
}

export interface PluginExecOptions {
  /** Written to the child's stdin, which is then closed. */
  stdin?: string;
  cwd?: string;
  /** Merged over the parent environment. */
  env?: Record<string, string>;
  /** Kills the child and rejects after this many milliseconds. */
  timeoutMs?: number;
  /** Kills the child and rejects when aborted. */
  signal?: AbortSignal;
}

export interface PluginExecResult {
  /** Null when the child was terminated by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type PluginNotifyVariant = 'info' | 'warning' | 'error';

export interface PluginLogger {
  debug: (message: string, ...meta: unknown[]) => void;
  info: (message: string, ...meta: unknown[]) => void;
  warn: (message: string, ...meta: unknown[]) => void;
  error: (message: string, ...meta: unknown[]) => void;
}

type Disposer = () => void;

/** The API object passed to a plugin's `activate(ctx)`. */
export interface PluginContext<TUnstable = unknown> {
  readonly id: string;
  /** Absolute path of the plugin directory. */
  readonly dir: string;
  /** `plugins.<id>.settings` from config. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly log: PluginLogger;
  /** Repeating timer; cleared automatically when the plugin unloads. */
  every: (intervalMs: number, callback: () => unknown) => Disposer;
  /** One-shot timer; cleared automatically when the plugin unloads. */
  after: (delayMs: number, callback: () => unknown) => Disposer;
  readonly mpv: {
    readonly connected: boolean;
    on: <E extends PluginMpvEventName>(
      event: E,
      listener: (payload: PluginMpvEventMap[E]) => unknown,
    ) => Disposer;
    command: (command: (string | number)[]) => void;
    getProperty: (name: string) => Promise<unknown>;
  };
  readonly subtitles: {
    current: () => PluginSubtitleLine | null;
    context: (options?: { before?: number; after?: number }) => PluginSubtitleContext;
  };
  readonly actions: {
    /** Bind with `["__plugin-action:<plugin id>/<name>"]` in `keybindings`. */
    register: (name: string, handler: () => unknown) => Disposer;
  };
  notify: (message: string, options?: { variant?: PluginNotifyVariant }) => void;
  readonly ui: {
    /** Opens the shared plugin panel, replacing any panel that is already open. */
    panel: (content: Partial<PluginPanelContent> & { markdown: string }) => PluginPanelHandle;
  };
  /** Runs a binary without a shell, with the AppImage library path removed from its environment. */
  exec: (command: string, args: string[], options?: PluginExecOptions) => Promise<PluginExecResult>;
  /** Raw app internals. No stability guarantee across releases. */
  readonly unstable: TUnstable;
}

export interface PluginModule {
  activate?: (ctx: PluginContext) => unknown;
  deactivate?: () => unknown;
  default?: { activate?: (ctx: PluginContext) => unknown; deactivate?: () => unknown };
}
