import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPluginHost, type PluginHostDeps } from './plugin-host';
import type { PluginConfigEntry, PluginLogger, PluginMpvEventName } from './types';

function writePlugin(root: string, id: string, files: Record<string, string>): void {
  const dir = path.join(root, id);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
}

function createHarness(config: Record<string, PluginConfigEntry>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'subminer-plugins-'));
  const errors: string[] = [];
  const notifications: string[] = [];
  const logger: PluginLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => errors.push(message),
  };
  const deps: PluginHostDeps<{ marker: string }> = {
    pluginsDir: root,
    getPluginConfig: () => config,
    createLogger: () => logger,
    isMpvConnected: () => true,
    sendMpvCommand: () => {},
    requestMpvProperty: async () => null,
    getCurrentSubtitle: () => null,
    getSubtitleContext: () => ({ current: null, before: [], after: [] }),
    notify: (message) => notifications.push(message),
    openPanel: () => {
      throw new Error('not used');
    },
    unstable: { marker: 'internals' },
  };
  return {
    root,
    errors,
    notifications,
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

    assert.equal(h.host.runAction('greeter/say'), true);
    assert.deepEqual(h.notifications, ['hi internals']);
    assert.equal(h.host.runAction('greeter/missing'), false);
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

    assert.equal(h.host.runAction('esm/go'), true);
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

    assert.equal(h.host.runAction('broken/half'), false);
    assert.equal(h.host.runAction('healthy/ok'), true);
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
