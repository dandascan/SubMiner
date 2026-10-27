type: added
area: plugins

- Added JavaScript plugins loaded at startup from `<config dir>/plugins/<id>/` and enabled under `plugins` in the config. Plugins can listen to mpv events, run timers, register actions bound with `__plugin-action:<id>/<action>` keybindings, run programs, and show markdown results in an overlay panel.
- Added an example `ai-explain` plugin that sends the current line and its neighbors to `codex exec` and shows a translation or grammar explanation.
