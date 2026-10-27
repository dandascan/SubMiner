import assert from 'node:assert/strict';
import test from 'node:test';

import { execPluginCommand } from './exec';

// The test runtime (bun or node) doubles as a portable child process.
const runtime = process.execPath;

test('pipes stdin to the child and collects stdout', async () => {
  const result = await execPluginCommand(
    runtime,
    ['-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))'],
    { stdin: '字幕 line' },
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '字幕 LINE');
});

test('resolves with a non-zero exit code and stderr', async () => {
  const result = await execPluginCommand(runtime, [
    '-e',
    'process.stderr.write("bad things"); process.exit(3)',
  ]);

  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'bad things');
});

test('drops the AppImage library path from the child environment', async () => {
  const previous = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = '/tmp/.mount_SubMinXXXXXX/usr/lib';
  try {
    const result = await execPluginCommand(
      runtime,
      ['-e', 'process.stdout.write(String(process.env.LD_LIBRARY_PATH) + "|" + process.env.EXTRA)'],
      { env: { EXTRA: 'kept' } },
    );
    assert.equal(result.stdout, 'undefined|kept');
  } finally {
    if (previous === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previous;
  }
});

test('aborting kills the child and rejects with AbortError', async () => {
  const controller = new AbortController();
  const pending = execPluginCommand(runtime, ['-e', 'setTimeout(() => {}, 60_000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(pending, { name: 'AbortError' });
});

test('rejects when the binary does not exist', async () => {
  await assert.rejects(
    execPluginCommand('subminer-definitely-missing-binary', []),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});
