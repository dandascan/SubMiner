# Plugins

Plugins are JavaScript files that SubMiner loads at startup. A plugin can react to playback, run code on a timer, add actions you bind to keys, run programs, and show results in an overlay panel, all without rebuilding SubMiner.

::: warning Only run plugins you trust
Plugins run inside SubMiner with the same access to your files and system as SubMiner itself. There is no sandbox.
:::

These are SubMiner app plugins. The Lua script that runs inside mpv is the separate [mpv plugin](/mpv-plugin).

## Install a plugin

1. Put the plugin in its own folder in `plugins/` next to your [config file](/configuration#configuration-file), for example `~/.config/SubMiner/plugins/ai-explain/`. The folder name is the plugin id.
2. Enable it in `config.jsonc`. `settings` is passed to the plugin as-is:

   ```jsonc
   {
     "plugins": {
       "ai-explain": { "enabled": true, "settings": { "reasoningEffort": "medium" } },
     },
   }
   ```

3. Bind its actions to keys with the `__plugin-action:<plugin id>/<action>` command:

   ```jsonc
   {
     "keybindings": [
       { "key": "Ctrl+KeyE", "command": ["__plugin-action:ai-explain/explain"] },
       { "key": "Ctrl+KeyT", "command": ["__plugin-action:ai-explain/translate"] },
     ],
   }
   ```

4. Restart SubMiner. Plugin changes apply on the next start; keybinding changes apply immediately.

Load errors and plugin log output go to the app log with a `plugin:<id>` scope.

## Example: explain the current line with Codex

The repository ships [`examples/plugins/ai-explain`](https://github.com/ksyasuda/SubMiner/tree/main/examples/plugins/ai-explain). It sends the current line, plus the lines around it, to [`codex exec`](https://github.com/openai/codex) and shows the answer in a panel. It needs a logged-in Codex CLI.

| Action      | What it does                                                    |
| ----------- | --------------------------------------------------------------- |
| `explain`   | Translation plus a breakdown of the grammar and vocabulary      |
| `translate` | Natural English translation, with a note only when it's unclear |

| Setting           | Default   | What it does                                                      |
| ----------------- | --------- | ----------------------------------------------------------------- |
| `codexPath`       | `"codex"` | Codex binary. Use a full path if SubMiner can't find it on `PATH` |
| `model`           | `""`      | Model passed to `codex exec -m`; empty uses your Codex config     |
| `reasoningEffort` | `"low"`   | Codex reasoning effort; empty uses your Codex config              |
| `before`, `after` | `2`, `1`  | Lines of context sent before and after the current line           |
| `pause`           | `true`    | Pause playback when the panel opens                               |
| `timeoutMs`       | `120000`  | Give up after this long                                           |
| `prompts`         | `{}`      | Replace an action's instructions, e.g. `{ "translate": "..." }`   |

Press `Esc` to close the panel. Closing it, or starting another request, stops the running Codex process.

## Write a plugin

A plugin folder needs a `plugin.json`:

```json
{ "name": "My Plugin", "version": "1.0.0", "main": "main.mjs" }
```

`main` points to a CommonJS or ES module that exports `activate(ctx)`. It may return a cleanup function, or the module can export `deactivate()`. Everything a plugin registers through `ctx` (listeners, timers, actions, panels, running programs) is cleaned up automatically when SubMiner quits.

```js
export function activate(ctx) {
  ctx.mpv.on('media-path-change', ({ path }) => ctx.log.info(`Now playing ${path}`));
  ctx.every(60_000, () => ctx.log.info('Still watching'));
  ctx.actions.register('hello', () => {
    const line = ctx.subtitles.current();
    ctx.ui.panel({ title: 'Hello', markdown: line ? `> ${line.text}` : '_No subtitle_' });
  });
}
```

An error thrown by a plugin is logged and does not crash SubMiner. A plugin that blocks with a long synchronous loop still freezes the app, so keep slow work asynchronous.

### `ctx` reference

| Member                                 | What it does                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`, `dir`, `settings`                | Plugin id, plugin folder path, and `plugins.<id>.settings`                                              |
| `log.debug/info/warn/error(message)`   | Write to the app log                                                                                    |
| `every(ms, fn)`, `after(ms, fn)`       | Repeating and one-shot timers. Return a function that cancels them                                      |
| `mpv.on(event, fn)`                    | Listen to mpv events (below). Returns an unsubscribe function                                           |
| `mpv.command(args)`                    | Send an mpv command, e.g. `['set', 'pause', 'yes']`                                                     |
| `mpv.getProperty(name)`                | Read an mpv property (Promise)                                                                          |
| `mpv.connected`                        | Whether mpv is connected                                                                                |
| `subtitles.current()`                  | The displayed line as `{ text, startTime, endTime }`, or `null`                                         |
| `subtitles.context({ before, after })` | `{ current, before, after }`. Neighbors come from the loaded subtitle file, or recent lines for streams |
| `actions.register(name, fn)`           | Add an action, bindable as `__plugin-action:<id>/<name>`                                                |
| `notify(message, { variant })`         | Overlay notification. `variant` is `info`, `warning`, or `error`                                        |
| `ui.panel({ title, markdown })`        | Open the plugin panel. Returns `{ update(content), close(), closed, signal }`                           |
| `exec(command, args, options)`         | Run a program without a shell. Resolves `{ exitCode, stdout, stderr }`                                  |
| `unstable`                             | SubMiner internals. These change between releases without notice                                        |

A panel's `signal` aborts when the user closes it or another panel replaces it. Pass it to `exec` to stop work nobody will see. Only one panel is open at a time. Panel markdown supports headings, lists, quotes, code, bold, and italics; HTML is shown as plain text.

`exec` options are `stdin`, `cwd`, `env`, `timeoutMs`, and `signal`. It resolves for any exit code and rejects when the program can't start, times out, or is aborted.

mpv events: `connection-change`, `subtitle-change`, `subtitle-timing`, `time-pos-change`, `duration-change`, `pause-change`, `fullscreen-change`, `media-path-change`, `media-title-change`, `subtitle-track-change`, `subtitle-track-list-change`, `secondary-subtitle-change`, `secondary-subtitle-track-change`, `secondary-subtitle-delay-change`, `secondary-subtitle-visibility`, and `client-message`.
