/**
 * Pure helpers for turning a user's deck label ("80s", "90er Rock", "Schlager") into
 * search parameters, and for cleaning up Spotify track metadata. No I/O.
 */

export interface YearRange {
  from: number;
  to: number;
}

export interface ParsedLabel {
  /** Decade / year span named in the label, if any */
  range: YearRange | null;
  /** What's left once years and filler words are removed ("" = decade only) */
  topic: string;
}

// Words that describe "a deck of well-known songs" rather than its content
const FILLER_WORDS = new Set([
  'hits', 'hit', 'songs', 'song', 'music', 'musik', 'best', 'of', 'the', 'greatest', 'top',
  'classics', 'classic', 'jahre', 'der', 'die', 'das', 'beste', 'besten', 'größten', 'grossten',
  'all', 'time', 'aller', 'zeiten', 'und', 'and', 'party', 'playlist',
]);

/** Decades used when the label doesn't name one — keeps decks spread across eras. */
export const DEFAULT_DECADES: YearRange[] = [1960, 1970, 1980, 1990, 2000, 2010, 2020].map(
  from => ({ from, to: from + 9 }),
);

export function parseLabel(label: string): ParsedLabel {
  let text = ` ${label.toLowerCase().replace(/[’'`´]/g, '')} `;
  let range: YearRange | null = null;

  const span = text.match(/\b((?:19|20)\d{2})\s*[-–]\s*((?:19|20)\d{2})\b/);
  const decade = text.match(/\b(19|20)?(\d)0\s*(s|er|ies)\b/);
  const year = text.match(/\b(19[4-9]\d|20[0-3]\d)\b/);

  if (span) {
    const a = Number(span[1]);
    const b = Number(span[2]);
    range = { from: Math.min(a, b), to: Math.max(a, b) };
    text = text.replace(span[0], ' ');
  } else if (decade) {
    const digit = Number(decade[2]);
    const century = decade[1] ? Number(decade[1]) * 100 : digit >= 3 ? 1900 : 2000;
    const from = century + digit * 10;
    range = { from, to: from + 9 };
    text = text.replace(decade[0], ' ');
  } else if (/\by2k\b/.test(text)) {
    range = { from: 1998, to: 2004 };
    text = text.replace(/\by2k\b/, ' ');
  } else if (year) {
    range = { from: Number(year[1]), to: Number(year[1]) };
    text = text.replace(year[0], ' ');
  }

  const topic = text
    .replace(/[^\p{L}\p{N}&+\- ]/gu, ' ')
    .split(/\s+/)
    .filter(w => w && !FILLER_WORDS.has(w))
    .join(' ')
    .trim();

  return { range, topic };
}

const VERSION_WORDS =
  /\b(re-?master(ed)?|mono|stereo|radio edit|single edit|single version|album version|edit|version|remix|mix|live|demo|acoustic|bonus track|from .+)\b/i;

/**
 * "Hotel California - 2013 Remaster" → "Hotel California",
 * "Africa (Remastered 2019)" → "Africa". Keeps titles players can actually name.
 */
export function cleanTrackTitle(title: string): string {
  let cleaned = title.trim();
  // Trailing " - <suffix>" segments describing the version
  const dash = cleaned.match(/^(.+?)\s+-\s+([^-]+)$/);
  if (dash && /\b(re-?master(ed)?|mono|stereo|radio edit|single edit|single version|album version|edit|version)\b/i.test(dash[2])) {
    cleaned = dash[1];
  }
  // Trailing "(Remastered 2009)" / "[Mono]"
  cleaned = cleaned.replace(
    /\s*[([](?:[^)\]]*\b(?:re-?master(?:ed)?|mono|stereo|radio edit|single version|album version|single mix|original mix|mix|edit|version)\b[^)\]]*)[)\]]\s*$/i,
    '',
  );
  return cleaned.trim() || title.trim();
}

/** True when the version suffix means the release year is probably not the song's year. */
export function hasVersionSuffix(title: string): boolean {
  return cleanTrackTitle(title) !== title.trim() || VERSION_WORDS.test(title.split(' - ').slice(1).join(' - '));
}

/**
 * Release year likely belongs to a re-release (remaster, compilation, live album …),
 * so the original year must be looked up before the card can be trusted.
 */
export function isSuspiciousRelease(trackName: string, albumName: string, albumType?: string): boolean {
  if (albumType === 'compilation') return true;
  if (hasVersionSuffix(trackName)) return true;
  return /\b(re-?master(ed)?|anniversary|deluxe|expanded|edition|reissue|greatest|best of|hits|collection|essential|anthology|live|gold|platinum)\b/i.test(
    albumName,
  );
}

/** Key for spotting the same song in different releases */
export function songKey(title: string, artist: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return `${norm(cleanTrackTitle(title))}|${norm(artist.split(',')[0] ?? '')}`;
}
