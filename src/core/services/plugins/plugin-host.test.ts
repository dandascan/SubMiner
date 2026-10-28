import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BrowserWindow } from 'electron';

import type { SessionActionDispatchRequest } from '../../../types/runtime';
import { createPluginHost, type PluginHostDeps } from './plugin-host';
import type {
  PluginConfigEntry,
  PluginLogger,
  PluginMpvEventName,
  PluginWindowRequest,
} from './types';

function writePlugin(root: string, id: string, files: Record<string, string>): void {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

type FakeWindow = ReturnType<typeof createFakeWindow>;

/** The slice of BrowserWindow the host touches: destroy, isDestroyed, and the `closed` event. */
function createFakeWindow() {
  const events = new EventEmitter();
  const fake = {
    destroyed: false,
    isDestroyed: () => fake.destroyed,
    destroy: () => {
      fake.destroyed = true;
      events.emit('closed');
    },
    once: (event: string, listener: () => void) => events.once(event, listener),
    asWindow: () => fake as unknown as BrowserWindow,
  };
  return fake;
}

function createHarness(
  config: Record<string, PluginConfigEntry>,
  overrides: Partial<PluginHostDeps<{ marker: string }>> = {},
) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'subminer-plugins-'));
  const errors: string[] = [];
  const notifications: string[] = [];
  const sessionActions: SessionActionDispatchRequest[] = [];
  const windowRequests: PluginWindowRequest[] = [];
  const windows = new Map<string, FakeWindow>();
  const logger: PluginLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => errors.push(message),
  };
  const deps: PluginHostDeps<{ marker: string }> = {
    pluginsDir: path.join(root, 'plugins'),
    pluginDataDir: path.join(root, 'data'),
    getPluginConfig: () => config,
    createLogger: () => logger,
    isMpvConnected: () => true,
    sendMpvCommand: () => {},
    requestMpvProperty: async () => null,
    ensureMpvRunning: async () => true,
    invokeAnkiConnect: async () => null,
    dispatchSessionAction: async (request) => {
      sessionActions.push(request);
    },
    getCurrentSubtitle: () => null,
    getSubtitleContext: () => ({ current: null, before: [], after: [] }),
    notify: (message) => notifications.push(message),
    openPanel: () => {
      throw new Error('not used');
    },
    openWindow: (request) => {
      windowRequests.push(request);
      const existing = windows.get(request.key);
      if (existing && !existing.destroyed) return { window: existing.asWindow(), created: false };
      const window = createFakeWindow();
      windows.set(request.key, window);
      return { window: window.asWindow(), created: true };
    },
    unstable: { marker: 'internals' },
    ...overrides,
  };
  return {
    root: deps.pluginsDir,
    dataRoot: deps.pluginDataDir,
    errors,
    notifications,
    sessionActions,
    windowRequests,
    windows,
    host: createPluginHost(deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const enabled = (settings: Record<string, unknown> = {}): PluginConfigEntry => ({
  enabled: true,
  settings,
});

function createFakeMpvClient() {
  const bus = new EventEmitter();
  return {
    on: (event: PluginMpvEventName, listener: (payload: unknown) => void) =>
      bus.on(event, listener),
    off: (event: PluginMpvEventName, listener: (payload: unknown) => void) =>
      bus.off(event, listener),
    emit: (event: PluginMpvEventName, payload: unknown) => bus.emit(event, payload),
  };
}

test('loads enabled plugins and runs their registered actions', async () => {
  const h = createHarness({
    greeter: enabled({ greeting: 'hi' }),
    off: { enabled: false, settings: {} },
  });
  try {
    writePlugin(h.root, 'greeter', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.actions.register('say', () => ctx.notify(ctx.settings.greeting + ' ' + ctx.unstable.marker));
      };`,
    });
    writePlugin(h.root, 'off', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `throw new Error('disabled plugins must not load');`,
    });

    await h.host.loadAll();

    assert.equal(await h.host.runAction('greeter/say'), true);
    assert.deepEqual(h.notifications, ['hi internals']);
    assert.equal(await h.host.runAction('greeter/missing'), false);
    assert.deepEqual(h.errors, []);
  } finally {
    h.cleanup();
  }
});

test('loads ES module plugins', async () => {
  const h = createHarness({ esm: enabled() });
  try {
    writePlugin(h.root, 'esm', {
      'plugin.json': JSON.stringify({ main: 'main.mjs' }),
      'main.mjs': `export function activate(ctx) { ctx.actions.register('go', () => ctx.notify('esm')); }`,
    });

    await h.host.loadAll();

    assert.equal(await h.host.runAction('esm/go'), true);
    assert.deepEqual(h.notifications, ['esm']);
  } finally {
    h.cleanup();
  }
});

test('a failed activation rolls back its registrations without affecting other plugins', async () => {
  const h = createHarness({ broken: enabled(), healthy: enabled() });
  try {
    writePlugin(h.root, 'broken', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.actions.register('half', () => {});
        throw new Error('boom');
      };`,
    });
    writePlugin(h.root, 'healthy', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => { ctx.actions.register('ok', () => {}); };`,
    });

    await h.host.loadAll();

    assert.equal(await h.host.runAction('broken/half'), false);
    assert.equal(await h.host.runAction('healthy/ok'), true);
    assert.deepEqual(h.errors, ['Activation failed: boom']);
  } finally {
    h.cleanup();
  }
});

test('rejects entry files outside the plugin directory', async () => {
  const h = createHarness({ escape: enabled() });
  try {
    writePlugin(h.root, 'escape', {
      'plugin.json': JSON.stringify({ main: '../elsewhere.cjs' }),
    });

    await h.host.loadAll();

    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0]!, /must stay inside/);
  } finally {
    h.cleanup();
  }
});

test('mpv listener errors are contained and unload detaches listeners and calls deactivate', async () => {
  const h = createHarness({ watcher: enabled() });
  const client = createFakeMpvClient();
  try {
    writePlugin(h.root, 'watcher', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.mpv.on('pause-change', ({ paused }) => {
          ctx.notify('paused=' + paused);
          throw new Error('listener bug');
        });
        return () => ctx.notify('deactivated');
      };`,
    });
    h.host.attachMpvClient(client);
    await h.host.loadAll();

    client.emit('pause-change', { paused: true });
    assert.deepEqual(h.notifications, ['paused=true']);
    assert.deepEqual(h.errors, ['mpv pause-change listener failed: listener bug']);

    await h.host.unloadAll();
    client.emit('pause-change', { paused: false });
    assert.deepEqual(h.notifications, ['paused=true', 'deactivated']);
  } finally {
    h.cleanup();
  }
});

test('unload gives up on a deactivate that never settles and still disposes the plugin', async () => {
  const h = createHarness({ stuck: enabled() }, { deactivateTimeoutMs: 20 });
  const client = createFakeMpvClient();
  try {
    writePlugin(h.root, 'stuck', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.mpv.on('pause-change', () => ctx.notify('still listening'));
        return () => new Promise(() => {});
      };`,
    });
    h.host.attachMpvClient(client);
    await h.host.loadAll();

    await h.host.unloadAll();
    client.emit('pause-change', { paused: true });

    assert.deepEqual(h.notifications, []);
    assert.deepEqual(h.errors, ['deactivate failed: timed out after 20 ms']);
  } finally {
    h.cleanup();
  }
});

test('events follow a replacement mpv client', async () => {
  const h = createHarness({ watcher: enabled() });
  const first = createFakeMpvClient();
  const second = createFakeMpvClient();
  try {
    writePlugin(h.root, 'watcher', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.mpv.on('media-path-change', ({ path }) => ctx.notify(path));
      };`,
    });
    h.host.attachMpvClient(first);
    await h.host.loadAll();
    h.host.attachMpvClient(second);

    first.emit('media-path-change', { path: 'stale.mkv' });
    second.emit('media-path-change', { path: 'current.mkv' });

    assert.deepEqual(h.notifications, ['current.mkv']);
  } finally {
    h.cleanup();
  }
});

test('unload waits for an in-progress load so late plugins are unloaded too', async () => {
  const h = createHarness({ late: enabled() });
  const client = createFakeMpvClient();
  try {
    writePlugin(h.root, 'late', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.mpv.on('pause-change', () => ctx.notify('still listening'));
        return () => ctx.notify('deactivated');
      };`,
    });
    h.host.attachMpvClient(client);

    // The plugin is still reading its manifest when unload starts.
    void h.host.loadAll();
    await h.host.unloadAll();
    client.emit('pause-change', { paused: true });

    assert.deepEqual(h.notifications, ['deactivated']);
  } finally {
    h.cleanup();
  }
});

test('a plugin that finishes activating after unload gave up unloads itself', async () => {
  const h = createHarness({ slow: enabled() }, { deactivateTimeoutMs: 20 });
  const client = createFakeMpvClient();
  try {
    writePlugin(h.root, 'slow', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        ctx.mpv.on('pause-change', () => ctx.notify('still listening'));
        return () => ctx.notify('deactivated');
      };`,
    });
    h.host.attachMpvClient(client);

    const loading = h.host.loadAll();
    await h.host.unloadAll();
    await loading;
    client.emit('pause-change', { paused: true });

    assert.deepEqual(h.notifications, ['deactivated']);
  } finally {
    h.cleanup();
  }
});

test('runAction waits for a load that is still in progress', async () => {
  const h = createHarness({ slow: enabled() });
  try {
    writePlugin(h.root, 'slow', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ctx.actions.register('go', () => ctx.notify('went'));
      };`,
    });

    void h.host.loadAll();

    assert.equal(await h.host.runAction('slow/go'), true);
    assert.deepEqual(h.notifications, ['went']);
  } finally {
    h.cleanup();
  }
});

test('each plugin gets its own data folder, created before activate', async () => {
  const h = createHarness({ keeper: enabled() });
  try {
    writePlugin(h.root, 'keeper', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `const fs = require('node:fs');
      exports.activate = (ctx) => {
        fs.writeFileSync(require('node:path').join(ctx.dataDir, 'state.json'), '{}');
        ctx.notify(ctx.dataDir);
      };`,
    });

    await h.host.loadAll();

    const expected = path.join(h.dataRoot, 'keeper');
    assert.deepEqual(h.notifications, [expected]);
    assert.equal(existsSync(path.join(expected, 'state.json')), true);
    assert.deepEqual(h.errors, []);
  } finally {
    h.cleanup();
  }
});

test('anki card-mined reaches listeners until unload, and invoke forwards to AnkiConnect', async () => {
  const invoked: unknown[][] = [];
  const h = createHarness(
    { syncer: enabled() },
    {
      invokeAnkiConnect: async (...args) => {
        invoked.push(args);
        return 'synced';
      },
    },
  );
  try {
    writePlugin(h.root, 'syncer', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.anki.on('card-mined', async ({ noteIds }) => {
          ctx.notify(noteIds.join(',') + ' ' + (await ctx.anki.invoke('sync', undefined, { timeoutMs: 5 })));
        });
      };`,
    });
    await h.host.loadAll();

    h.host.emitAnkiEvent('card-mined', { noteIds: [1, 2] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.notifications, ['1,2 synced']);
    assert.deepEqual(invoked, [['sync', {}, { timeoutMs: 5 }]]);

    await h.host.unloadAll();
    h.host.emitAnkiEvent('card-mined', { noteIds: [3] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.notifications.length, 1);
  } finally {
    h.cleanup();
  }
});

test('actions.run forwards built-in session actions', async () => {
  const h = createHarness({ caller: enabled() });
  try {
    writePlugin(h.root, 'caller', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = async (ctx) => {
        await ctx.actions.run('openJimaku');
        await ctx.actions.run('cycleRuntimeOption', { runtimeOptionId: 'x', direction: -1 });
      };`,
    });

    await h.host.loadAll();

    assert.deepEqual(h.sessionActions, [
      { actionId: 'openJimaku' },
      { actionId: 'cycleRuntimeOption', payload: { runtimeOptionId: 'x', direction: -1 } },
    ]);
  } finally {
    h.cleanup();
  }
});

test('openWindow resolves plugin files, reuses open windows, and closes them on unload', async () => {
  const h = createHarness({ viewer: enabled() });
  try {
    writePlugin(h.root, 'viewer', {
      'plugin.json': JSON.stringify({ main: 'main.cjs' }),
      'main.cjs': `exports.activate = (ctx) => {
        ctx.actions.register('open', () => ctx.ui.openWindow({ html: 'ui/index.html', preload: 'preload.js', width: 400 }));
        ctx.actions.register('escape', () => ctx.ui.openWindow({ html: '../other/index.html' }));
      };`,
    });
    await h.host.loadAll();

    await h.host.runAction('viewer/open');
    await h.host.runAction('viewer/open');
    const dir = path.join(h.root, 'viewer');
    assert.deepEqual(h.windowRequests[0], {
      key: `viewer:${path.join(dir, 'ui', 'index.html')}`,
      htmlPath: path.join(dir, 'ui', 'index.html'),
      preloadPath: path.join(dir, 'preload.js'),
      title: 'viewer',
      width: 400,
      height: 720,
    });
    assert.equal(h.windows.size, 1);

    await h.host.runAction('viewer/escape');
    assert.equal(h.windowRequests.length, 2);
    assert.match(h.errors[0] ?? '', /must stay inside/);

    const [window] = [...h.windows.values()];
    await h.host.unloadAll();
    assert.equal(window?.destroyed, true);
  } finally {
    h.cleanup();
  }
});
