/**
 * Lenient comparison of a player's song guess with the real title / artist.
 * Pure functions — used by the turn:name handler.
 *
 * Ignored: case, accents, punctuation, "&" vs "and", a leading "the", bracketed or
 * dashed suffixes ("(feat. X)", "- Remastered 2011", "[Live]"), and small typos.
 * Artist: naming one of several credited artists is enough.
 */

export function normalizeGuess(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')          // accents
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')                    // don't → dont
    .replace(/[^\p{L}\p{N}]+/gu, ' ')          // other punctuation → space
    .replace(/^the /, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Song (feat. X) - Remastered 2011" → "Song" */
function stripTitleExtras(title: string): string {
  return title
    .replace(/\s*[([{].*?[)\]}]/g, '')
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Equal after normalising, allowing about one typo per five characters (none for very short names). */
function close(guess: string, target: string): boolean {
  const g = normalizeGuess(guess);
  const t = normalizeGuess(target);
  if (!g || !t) return false;
  if (g === t) return true;
  if (g.replace(/ /g, '') === t.replace(/ /g, '')) return true;
  const allowed = t.length <= 3 ? 0 : Math.max(1, Math.floor(t.length / 5));
  return levenshtein(g, t) <= allowed;
}

export function titleMatches(guess: string, title: string): boolean {
  return close(guess, title) || close(stripTitleExtras(guess), stripTitleExtras(title));
}

export function artistMatches(guess: string, artist: string): boolean {
  if (close(guess, artist)) return true;
  const credited = artist.split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/i).filter(Boolean);
  const guesses = guess.split(/\s*(?:,|&|\band\b|\bund\b|\bx\b|\bfeat\.?|\bft\.?)\s*/i).filter(Boolean);
  return guesses.some(g => credited.some(a => close(g, a)));
}
