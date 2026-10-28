// Opens the Jimaku subtitle search when a file starts without a Japanese subtitle track.
// It waits a few seconds after the file loads so external subtitles mpv or SubMiner add count.

const DEFAULT_SETTINGS = {
  // Built-in action to run, e.g. `openTsukihime` or `openSubtitleSelection`.
  action: 'openJimaku',
  // Track `lang` codes that count as Japanese. Track titles with "Japanese" or 日本語 count too.
  languages: ['ja', 'jp', 'jpn'],
  delayMs: 3_000,
  // Also check http(s) streams; Jimaku can only search by name, which streams rarely have.
  streams: false,
};

const JAPANESE_TITLE = /japanese|日本語/i;

function activate(ctx) {
  const settings = { ...DEFAULT_SETTINGS, ...ctx.settings };
  const languages = new Set(settings.languages.map((lang) => lang.toLowerCase()));
  let cancelCheck = null;
  // Bumped on every file change so a check still waiting on mpv knows it is stale.
  let generation = 0;

  function hasJapaneseSubtitle(trackList) {
    return trackList.some(
      (track) =>
        track?.type === 'sub' &&
        (languages.has(String(track.lang ?? '').toLowerCase()) ||
          JAPANESE_TITLE.test(String(track.title ?? ''))),
    );
  }

  async function check(mediaPath, checkGeneration) {
    cancelCheck = null;
    const [currentPath, trackList] = await Promise.all([
      ctx.mpv.getProperty('path'),
      ctx.mpv.getProperty('track-list'),
    ]);
    // Another file started while we waited, even if it was this one again; its own check is
    // already scheduled.
    if (checkGeneration !== generation) return;
    if (currentPath !== mediaPath || !Array.isArray(trackList)) return;
    if (hasJapaneseSubtitle(trackList)) return;
    ctx.log.info(`No Japanese subtitles for ${mediaPath}; running ${settings.action}.`);
    await ctx.actions.run(settings.action);
  }

  ctx.mpv.on('media-path-change', ({ path: mediaPath }) => {
    generation += 1;
    cancelCheck?.();
    cancelCheck = null;
    if (!mediaPath) return;
    if (!settings.streams && /^[a-z]+:\/\//i.test(mediaPath)) return;
    const checkGeneration = generation;
    cancelCheck = ctx.after(settings.delayMs, () => check(mediaPath, checkGeneration));
  });
}

module.exports = { activate };
