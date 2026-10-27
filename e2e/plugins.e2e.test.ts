import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import type { CdpPage } from './harness/cdp';
import { FIXTURE_CUES } from './harness/fixtures';
import { OVERLAY_PAGE, startE2eSession, type E2eSession } from './harness/session';
import { waitUntil } from './harness/wait';

// Bun caps node:test hooks at 5s whatever their timeout option says, so the
// session boots inside whichever test runs first and every test budgets for it.
const TEST_TIMEOUT_MS = 120_000;

// Opens a panel describing the subtitle context and a child process result, and
// logs when the panel's signal aborts so the test can see the close reach main.
const PROBE_PLUGIN = `
exports.activate = (ctx) => {
  ctx.actions.register('show', () => {
    const { before, current, after } = ctx.subtitles.context({ before: 1, after: 1 });
    const panel = ctx.ui.panel({ title: 'Probe', markdown: '_working_' });
    panel.signal.addEventListener('abort', () => ctx.log.info('probe panel aborted'));
    ctx
      .exec(process.execPath, ['-e', 'process.stdout.write("child-ok")'], {
        env: { ELECTRON_RUN_AS_NODE: '1' },
        signal: panel.signal,
      })
      .then((result) =>
        panel.update({
          markdown: [
            '## ' + ctx.settings.greeting,
            '',
            '- before: ' + before.map((line) => line.text).join('|'),
            '- current: **' + (current ? current.text : '') + '**',
            '- after: ' + after.map((line) => line.text).join('|'),
            '- exec: ' + result.stdout,
          ].join('\\n'),
        }),
      )
      .catch((error) => panel.update({ markdown: 'exec failed: ' + error.message }));
  });
};
`;

type Started = { session: E2eSession; overlay: CdpPage };
let started: Promise<Started> | undefined;

function useSession(): Promise<Started> {
  started ??= (async () => {
    const session = await startE2eSession({
      config: { plugins: { 'e2e-probe': { enabled: true, settings: { greeting: 'hello' } } } },
      files: {
        'plugins/e2e-probe/plugin.json': JSON.stringify({ name: 'E2E Probe', main: 'main.cjs' }),
        'plugins/e2e-probe/main.cjs': PROBE_PLUGIN,
      },
    });
    try {
      return { session, overlay: await session.openPage(OVERLAY_PAGE) };
    } catch (error) {
      await session.dispose();
      throw error;
    }
  })();
  return started;
}

after(async () => {
  const running = await started?.catch(() => undefined);
  await running?.session.dispose();
});

type PanelState = {
  title: string;
  heading: string;
  current: string;
  items: string[];
};

test(
  'a plugin action opens the plugin panel with subtitle context and child process output',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { session, overlay } = await useSession();
    const [previous, cue, next] = FIXTURE_CUES;
    await session.mpv.command('seek', cue.at, 'absolute+exact');
    await overlay.waitFor(
      `document.getElementById('subtitleRoot').textContent === ${JSON.stringify(cue.text)}`,
      { description: `overlay to show "${cue.text}"` },
    );

    await session.runAppCommand(
      '--session-action',
      JSON.stringify({
        actionId: 'runPluginAction',
        payload: { pluginActionId: 'e2e-probe/show' },
      }),
    );

    const modal = await session.openPage('renderer/index.html?layer=modal');
    const panel = await modal
      .waitFor<PanelState | false>(
        `(() => {
        const root = document.getElementById('pluginPanelModal');
        const body = document.getElementById('pluginPanelBody');
        if (root.classList.contains('hidden') || !/exec[: ]/.test(body.textContent)) return false;
        return {
          title: document.getElementById('pluginPanelTitle').textContent,
          heading: body.querySelector('h4')?.textContent ?? '',
          current: body.querySelector('strong')?.textContent ?? '',
          items: Array.from(body.querySelectorAll('li'), (item) => item.textContent),
        };
      })()`,
        { description: 'plugin panel to show the finished probe result' },
      )
      .catch(async (error: unknown) => {
        const body = await modal.evaluate<string>(
          `document.getElementById('pluginPanelBody').textContent`,
        );
        throw new Error(`Plugin panel body: ${JSON.stringify(body)}`, { cause: error });
      });

    assert.deepEqual(panel, {
      title: 'Probe',
      heading: 'hello',
      current: cue.text,
      items: [
        `before: ${previous.text}`,
        `current: ${cue.text}`,
        `after: ${next.text}`,
        'exec: child-ok',
      ],
    });

    // Closing hides the modal window (Linux destroys it), often before Chromium
    // acknowledges the key event, so the send is not awaited. The plugin's log line
    // proves the close reached main and aborted the handle.
    void modal
      .send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      })
      .catch(() => {});
    await waitUntil(
      () =>
        fs.readFileSync(path.join(session.root, 'app.log'), 'utf8').includes('probe panel aborted'),
      { description: 'closing the panel to abort the plugin handle in main' },
    );
  },
);
