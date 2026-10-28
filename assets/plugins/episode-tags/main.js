// Tags each mined card with the show and episode it came from, e.g. `show::Frieren::S01E07`.
// The show and episode are parsed from the file name, or from mpv's media title for streams.
const path = require('node:path');

const DEFAULT_SETTINGS = {
  // Placeholders: {show}, {season}, {episode}, and {ep} (S01E07, or E07 without a season).
  // A tag stops before the first `::` level whose placeholder has no value.
  tags: ['show::{show}::{ep}'],
  notify: false,
};

// Tried in order; the first match wins. Runs on names with brackets and dots already removed.
const EPISODE_PATTERNS = [
  /^(?<show>.*?)\s*S(?<season>\d{1,2})\s?E(?<episode>\d{1,4})\b/i,
  /^(?<show>.*?)\s*(?:Season\s?(?<season>\d{1,2})\s*)?(?:Episode|Ep)\s?(?<episode>\d{1,4})\b/i,
  /^(?<show>.*?)\s+-\s+(?<episode>\d{1,4})(?:v\d)?\b/,
  /^(?<show>.*?)\s+(?<episode>\d{1,4})(?:v\d)?$/,
  /^(?<show>.*?)\s*第(?<episode>\d{1,4})話/,
];

// `[Group] Show Name - 07 (1080p).mkv` -> { show: 'Show Name', season: null, episode: '07' }
function parseMediaName(name) {
  const cleaned = name
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const pattern of EPISODE_PATTERNS) {
    const groups = cleaned.match(pattern)?.groups;
    const show = groups?.show.replace(/[\s-]+$/, '');
    if (!show) continue;
    return { show, season: pad(groups.season), episode: pad(groups.episode) };
  }
  return { show: cleaned || null, season: null, episode: null };
}

function pad(number) {
  return number ? String(Number(number)).padStart(2, '0') : null;
}

// Anki tags can't hold spaces, and a `::` in a value would add a hierarchy level.
function tagValue(value) {
  return value.replace(/::?/g, ' ').trim().replace(/\s+/g, '_').replace(/"/g, '');
}

function renderTag(template, values) {
  const levels = [];
  for (const level of template.split('::')) {
    let missing = false;
    const rendered = level.replace(/\{(\w+)\}/g, (_, key) => {
      const value = values[key];
      if (!value) missing = true;
      return value ? tagValue(value) : '';
    });
    if (missing) break;
    levels.push(rendered);
  }
  return levels.join('::');
}

// Files remembered for matching cards to what was playing; older cards are not tagged.
const MAX_HISTORY = 50;

function mediaName(mediaPath, title) {
  // A stream URL's last segment is usually an id, so streams use the title mpv shows.
  if (typeof mediaPath === 'string' && mediaPath && !/^[a-z]+:\/\//i.test(mediaPath)) {
    return path.basename(mediaPath);
  }
  return typeof title === 'string' && title ? title : null;
}

function renderTags(templates, name) {
  const { show, season, episode } = parseMediaName(name);
  const ep = episode ? `${season ? `S${season}` : ''}E${episode}` : null;
  const values = { show, season, episode, ep };
  return [...new Set(templates.map((template) => renderTag(template, values)))].filter(Boolean);
}

function activate(ctx) {
  const settings = { ...DEFAULT_SETTINGS, ...ctx.settings };
  // Files played since activation, oldest first. An Anki note id is the time the note was
  // added in milliseconds, so each card is tagged with the file playing when it was added,
  // even when card-mined fires after playback moved on (YouTube media, field grouping).
  const history = [];

  function remember(mediaPath, since) {
    history.push({ since, path: mediaPath || null, title: null });
    if (history.length > MAX_HISTORY) history.shift();
  }

  function nameAt(noteId) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const entry = history[i];
      if (entry.since <= noteId) return mediaName(entry.path, entry.title);
    }
    return null;
  }

  ctx.mpv.on('media-path-change', ({ path: mediaPath }) => remember(mediaPath, Date.now()));
  // SubMiner reads the title back after each path change, so it lands on the new file.
  ctx.mpv.on('media-title-change', ({ title }) => {
    const latest = history.at(-1);
    if (latest) latest.title = title;
  });

  // A file may already be playing when the plugin starts.
  const startedAt = Date.now();
  Promise.all([ctx.mpv.getProperty('path'), ctx.mpv.getProperty('media-title')])
    .then(([mediaPath, title]) => {
      if (history.length > 0 || typeof mediaPath !== 'string' || !mediaPath) return;
      remember(mediaPath, startedAt);
      history[0].title = typeof title === 'string' ? title : null;
    })
    .catch((error) => ctx.log.debug(`Could not read the playing media: ${error.message}`));

  ctx.anki.on('card-mined', async ({ noteIds }) => {
    // Notes from the same file share one addTags call.
    const notesByName = new Map();
    for (const noteId of noteIds) {
      const name = nameAt(noteId);
      if (!name) {
        ctx.log.debug(`Note ${noteId} was not added during a file SubMiner saw; not tagging it.`);
        continue;
      }
      notesByName.set(name, [...(notesByName.get(name) ?? []), noteId]);
    }

    for (const [name, notes] of notesByName) {
      const tags = renderTags(settings.tags, name);
      if (tags.length === 0) {
        ctx.log.debug(`No tags for "${name}".`);
        continue;
      }
      try {
        await ctx.anki.invoke('addTags', { notes, tags: tags.join(' ') });
        ctx.log.info(`Tagged ${notes.length} note(s): ${tags.join(' ')}`);
        if (settings.notify) ctx.notify(`Tagged ${tags.join(' ')}`);
      } catch (error) {
        ctx.log.warn(`Tagging failed: ${error.message}`);
        ctx.notify(`Episode tagging failed: ${error.message}`, { variant: 'error' });
      }
    }
  });
}

module.exports = { activate };
