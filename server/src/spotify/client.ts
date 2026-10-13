import { Card } from '@shared/types';
import { MOCK_TRACKS } from './mockTracks';
import {
  EmbedRateLimitError,
  fetchEmbedPlaylistTracks,
  fetchEmbedTrack,
  type EmbedPlaylistTrack,
  type EmbedTrack,
} from './embedPreview';
import {
  DEFAULT_DECADES,
  cleanTrackTitle,
  isSuspiciousRelease,
  parseLabel,
  songKey,
  type YearRange,
} from './labels';

/*
 * Deck building for a Client Credentials app in Spotify "development mode".
 *
 * Such apps get no /recommendations, no playlist contents, no batch endpoints, search
 * limit ≤ 10, no popularity/genres — and a small request quota (exceeding it blocks the app
 * for hours). So the Web API is used sparingly and cached:
 *   - Public embed pages (open.spotify.com/embed/…) — no API quota — supply playlist
 *     contents and per-track metadata (title, artists, release date, cover, preview MP3).
 *   - Decades and mixed decks come from Spotify's editorial "All Out 50s…2010s" playlists.
 *   - The API is only used for playlist search (genre/topic labels), the year search
 *     top-up (e.g. 2020s), and looking up original years of remasters/compilations.
 * The `genre:` search filter is avoided: it returns mostly obscure tracks.
 */

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  preview_url: string | null;
  external_urls?: { spotify?: string };
  album: {
    name?: string;
    album_type?: string;
    images: Array<{ url: string; width: number; height: number }>;
    release_date: string;
  };
}

interface SearchTracksPage {
  tracks?: { items: Array<SpotifyTrack | null> };
}

interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  items?: { total: number };
  tracks?: { total: number };
}

interface SearchPlaylistsPage {
  playlists?: { items: Array<SpotifyPlaylistSummary | null> };
}

/** Normalised track from either the Web API or an embed page */
interface Candidate {
  trackId: string;
  title: string;
  artists: string[];
  year: number | null;
  albumArt: string;
  streamUrl: string | null;
  albumName?: string;
  albumType?: string;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number };

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const MIN_PLAYABLE_TRACKS = 6;
const DEFAULT_MARKET = 'US';
/** Development-mode apps get 400 for anything above 10 */
const SEARCH_PAGE_SIZE = 10;
/** Cards per deck — more than any round needs (12 players + draws) */
const DECK_SIZE = 60;
/** Per-deck cap on API lookups of a remaster's original year */
const MAX_YEAR_LOOKUPS = 10;
const EMBED_CONCURRENCY = 3;
/** Pause after Spotify throttles embed pages */
const EMBED_COOLDOWN_MS = 10 * 60 * 1000;
/** Deepest year-search offset still made of well-known songs */
const MAX_YEAR_SEARCH_OFFSET = 300;
const HOUR_MS = 60 * 60 * 1000;

/** Spotify editorial "All Out <decade>" playlists — curated hits, readable via embed. */
const ALL_OUT_PLAYLISTS: Record<number, string> = {
  1950: '37i9dQZF1DWSV3Tk4GO2fq',
  1960: '37i9dQZF1DXaKIA8E7WcJj',
  1970: '37i9dQZF1DWTJ7xPn4vNaz',
  1980: '37i9dQZF1DX4UtSsGT1Sbe',
  1990: '37i9dQZF1DXbTxeAdrVG2l',
  2000: '37i9dQZF1DX4o1oenSJRJd',
  2010: '37i9dQZF1DX5Ejj0EkURtP',
};

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Map with at most `limit` promises in flight. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function inRange(year: number, range: YearRange): boolean {
  return year >= range.from && year <= range.to;
}

/** Small in-memory TTL cache — repeated decks and previews must not burn API quota. */
class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();
  constructor(private readonly maxEntries = 5_000) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

function candidateFromApi(track: SpotifyTrack): Candidate {
  const year = parseInt(track.album.release_date?.slice(0, 4) ?? '', 10);
  return {
    trackId: track.id,
    title: track.name,
    artists: track.artists.map(a => a.name),
    year: Number.isNaN(year) ? null : year,
    albumArt: track.album.images[0]?.url ?? '',
    streamUrl: track.preview_url,
    albumName: track.album.name,
    albumType: track.album.album_type,
  };
}

function candidateFromEmbed(track: EmbedTrack): Candidate {
  return {
    trackId: track.trackId,
    title: track.title,
    artists: track.artists,
    year: track.releaseYear,
    albumArt: track.albumArt,
    streamUrl: track.previewUrl,
  };
}

export class SpotifyClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  /** Set when Spotify answers 429 with a long Retry-After (quota exhausted) */
  private apiBlockedUntil = 0;
  /** Set when embed pages answer 429 — only cached embed data is used until then */
  private embedBlockedUntil = 0;
  private readonly apiCache = new TtlCache<unknown>();
  private readonly embedTrackCache = new TtlCache<EmbedTrack | null>(20_000);
  private readonly embedPlaylistCache = new TtlCache<EmbedPlaylistTrack[]>(500);

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly testMode = false,
  ) {}

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const res = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      throw new Error(`Spotify token request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private spotifyMarket(): string {
    return process.env.SPOTIFY_MARKET ?? DEFAULT_MARKET;
  }

  /** True while the app's API quota is exhausted — callers fall back to embed-only sources. */
  isApiBlocked(): boolean {
    return Date.now() < this.apiBlockedUntil;
  }

  /**
   * GET with caching. Returns the status on failure instead of throwing. A 429 with a long
   * Retry-After means the quota is gone — no retries until then (retries extend the block).
   */
  private async apiGet<T>(path: string, ttlMs = 24 * HOUR_MS): Promise<ApiResult<T>> {
    const cached = this.apiCache.get(path) as T | undefined;
    if (cached !== undefined) return { ok: true, data: cached };
    if (this.isApiBlocked()) return { ok: false, status: 429 };

    const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.ensureToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.('retry-after') ?? '5');
        const waitS = Number.isFinite(retryAfter) ? retryAfter : 5;
        if (waitS <= 5 && attempt < 2) {
          await new Promise(r => setTimeout(r, waitS * 1000));
          continue;
        }
        const alreadyBlocked = this.isApiBlocked();
        this.apiBlockedUntil = Date.now() + waitS * 1000;
        if (!alreadyBlocked) console.warn(
          `[Spotify] API quota exhausted — Web API paused until ${new Date(this.apiBlockedUntil).toISOString()}; using embed-only sources`,
        );
        return { ok: false, status: 429 };
      }
      if (!res.ok) return { ok: false, status: res.status };

      const data = (await res.json()) as T;
      this.apiCache.set(path, data, ttlMs);
      return { ok: true, data };
    }
  }

  private withMockGenres(card: Card): Card {
    if (card.genres?.length) return card;
    const y = card.releaseYear;
    let genres: string[];
    if (y < 1965) genres = ['rock', 'blues'];
    else if (y < 1980) genres = ['rock', 'soul'];
    else if (y < 1995) genres = ['pop', 'rock'];
    else if (y < 2010) genres = ['pop', 'hip-hop'];
    else genres = ['pop'];
    return { ...card, genres };
  }

  private toCard(c: Candidate, year: number): Card {
    return {
      trackId: c.trackId,
      title: cleanTrackTitle(c.title),
      artist: c.artists.join(', '),
      releaseYear: year,
      // Spotify play page; the turn's MP3 comes from streamUrl or the embed page
      previewUrl: `https://open.spotify.com/track/${c.trackId}`,
      streamUrl: c.streamUrl,
      albumArt: c.albumArt,
    };
  }

  // ── Embed sources (no API quota) ───────────────────────────────────────────

  private isEmbedBlocked(): boolean {
    return Date.now() < this.embedBlockedUntil;
  }

  private noteEmbedRateLimit(): void {
    if (!this.isEmbedBlocked()) {
      console.warn(`[Spotify] embed pages throttled (429) — using cached data only for ${EMBED_COOLDOWN_MS / 60_000} min`);
    }
    this.embedBlockedUntil = Date.now() + EMBED_COOLDOWN_MS;
  }

  private async embedPlaylist(playlistId: string): Promise<EmbedPlaylistTrack[]> {
    const cached = this.embedPlaylistCache.get(playlistId);
    if (cached) return cached;
    if (this.isEmbedBlocked()) throw new EmbedRateLimitError();
    try {
      const tracks = await fetchEmbedPlaylistTracks(playlistId);
      this.embedPlaylistCache.set(playlistId, tracks, 6 * HOUR_MS);
      return tracks;
    } catch (err) {
      if (err instanceof EmbedRateLimitError) this.noteEmbedRateLimit();
      throw err;
    }
  }

  /** Track metadata via embed pages; cached a week. Uncached tracks are skipped while throttled. */
  private async embedCandidates(refs: EmbedPlaylistTrack[]): Promise<Candidate[]> {
    const tracks = await mapPool(refs, EMBED_CONCURRENCY, async (ref) => {
      const cached = this.embedTrackCache.get(ref.trackId);
      if (cached !== undefined) return cached;
      if (this.isEmbedBlocked()) return null;
      try {
        const track = await fetchEmbedTrack(ref.trackId);
        this.embedTrackCache.set(ref.trackId, track, 7 * 24 * HOUR_MS);
        return track;
      } catch (err) {
        if (err instanceof EmbedRateLimitError) this.noteEmbedRateLimit();
        return null;
      }
    });
    return tracks.filter((t): t is EmbedTrack => t !== null).map(candidateFromEmbed);
  }

  // ── Release year correction ────────────────────────────────────────────────

  /**
   * Remasters and compilations carry the re-release date ("Hotel California - 2013 Remaster"
   * on a 2013 album). Hitster needs the song's year: the earliest matching release.
   * Returns null when the API can't tell (quota) — the caller then drops the track.
   */
  private async originalReleaseYear(c: Candidate): Promise<number | null> {
    const title = cleanTrackTitle(c.title).replace(/"/g, '');
    const artist = (c.artists[0] ?? '').replace(/"/g, '');
    const q = encodeURIComponent(`track:"${title}" artist:"${artist}"`);
    const result = await this.apiGet<SearchTracksPage>(
      `/search?q=${q}&type=track&limit=${SEARCH_PAGE_SIZE}&market=${encodeURIComponent(this.spotifyMarket())}`,
      30 * 24 * HOUR_MS,
    );
    if (!result.ok) return null;

    const wanted = songKey(c.title, artist);
    let earliest = c.year;
    for (const track of result.data.tracks?.items ?? []) {
      if (!track || songKey(track.name, track.artists[0]?.name ?? '') !== wanted) continue;
      const y = candidateFromApi(track).year;
      if (y !== null && (earliest === null || y < earliest)) earliest = y;
    }
    return earliest;
  }

  /**
   * Dedupe and turn candidates into cards. With a `range`, tracks outside it are dropped
   * (which also drops re-releases dated decades later). Without one, likely re-releases get
   * their original year looked up (capped) or are dropped — a wrong year is worse than none.
   */
  private async finalizeDeck(
    candidates: Candidate[],
    opts: { range?: YearRange | null; limit?: number } = {},
  ): Promise<Card[]> {
    const limit = opts.limit ?? DECK_SIZE;
    const seen = new Set<string>();
    const cards: Card[] = [];
    const suspicious: Candidate[] = [];

    for (const c of candidates) {
      const key = songKey(c.title, c.artists[0] ?? '');
      if (c.year === null || seen.has(key)) continue;
      seen.add(key);
      if (opts.range) {
        if (inRange(c.year, opts.range)) cards.push(this.toCard(c, c.year));
      } else if (isSuspiciousRelease(c.title, c.albumName ?? '', c.albumType)) {
        suspicious.push(c);
      } else {
        cards.push(this.toCard(c, c.year));
      }
    }

    if (cards.length < limit && suspicious.length > 0) {
      const toCheck = suspicious.slice(0, Math.min(MAX_YEAR_LOOKUPS, limit - cards.length));
      const years = await mapPool(toCheck, 3, (c) => this.originalReleaseYear(c));
      toCheck.forEach((c, i) => {
        const year = years[i];
        if (year !== null) cards.push(this.toCard(c, year));
      });
    }

    return cards.slice(0, limit);
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  /** Hits of the decades overlapping `range`, from the editorial All Out playlists. */
  private async decadePlaylistCards(range: YearRange, limit: number): Promise<Card[]> {
    const decades = Object.keys(ALL_OUT_PLAYLISTS)
      .map(Number)
      .filter((d) => d <= range.to && d + 9 >= range.from);
    if (decades.length === 0) return [];

    const refs: EmbedPlaylistTrack[] = [];
    for (const decade of decades) {
      try {
        refs.push(...(await this.embedPlaylist(ALL_OUT_PLAYLISTS[decade])));
      } catch (err) {
        console.warn(`[Spotify] All Out ${decade}s embed failed:`, err instanceof Error ? err.message : err);
      }
    }
    // Spans covering part of the decades keep only that fraction of tracks — sample more
    const covered = Math.min(range.to, decades[decades.length - 1] + 9) - Math.max(range.from, decades[0]) + 1;
    const fraction = Math.min(1, covered / (decades.length * 10));
    const sample = Math.ceil((limit * 1.3) / fraction);
    const candidates = await this.embedCandidates(shuffleArray(refs).slice(0, sample));
    return this.finalizeDeck(candidates, { range, limit });
  }

  /**
   * API year search (`year:` filter) — that era's best-known songs. Spotify answers with
   * ~5 items per page and no `next` link, yet every offset returns more hits.
   */
  private async yearSearchCards(range: YearRange, limit: number): Promise<Card[]> {
    if (this.isApiBlocked()) return [];
    const market = encodeURIComponent(this.spotifyMarket());
    const q = encodeURIComponent(`year:${range.from}-${range.to}`);
    const pageCount = Math.min(MAX_YEAR_SEARCH_OFFSET / SEARCH_PAGE_SIZE, Math.ceil(limit / 4));
    const deeper = Array.from({ length: MAX_YEAR_SEARCH_OFFSET / SEARCH_PAGE_SIZE - 1 }, (_, i) => (i + 1) * SEARCH_PAGE_SIZE);
    const offsets = [0, ...shuffleArray(deeper).slice(0, pageCount - 1)];
    const pages = await mapPool(offsets, 3, async (offset) => {
      const result = await this.apiGet<SearchTracksPage>(
        `/search?q=${q}&type=track&limit=${SEARCH_PAGE_SIZE}&offset=${offset}&market=${market}`,
      );
      return result.ok ? (result.data.tracks?.items ?? []) : [];
    });
    const candidates = pages.flat().filter((t): t is SpotifyTrack => !!t).map(candidateFromApi);
    return this.finalizeDeck(shuffleArray(candidates), { range, limit });
  }

  /** Cards for year spans, evenly spread: All Out playlists first, API year search to fill gaps. */
  async getTracksForYears(ranges: YearRange[], limit = DECK_SIZE): Promise<Card[]> {
    const perRange = Math.ceil(limit / ranges.length);
    const perRangeCards = await mapPool(ranges, 2, async (range) => {
      const cards = await this.decadePlaylistCards(range, perRange);
      if (cards.length >= perRange * 0.8) return cards;
      const have = new Set(cards.map((c) => songKey(c.title, c.artist)));
      const extra = await this.yearSearchCards(range, perRange - cards.length);
      return [...cards, ...extra.filter((c) => !have.has(songKey(c.title, c.artist)))];
    });
    const cards = perRangeCards.flat();
    console.log(
      `[Spotify] years ${ranges.map((r) => `${r.from}-${r.to}`).join(',')}: ${cards.length} cards`,
    );
    return cards;
  }

  /** Curated user/editorial playlists matching the label, best match first. */
  async searchPlaylists(label: string): Promise<SpotifyPlaylistSummary[]> {
    const market = encodeURIComponent(this.spotifyMarket());
    const query = /\bhits?\b/i.test(label) ? label : `${label} hits`;
    const result = await this.apiGet<SearchPlaylistsPage>(
      `/search?q=${encodeURIComponent(query)}&type=playlist&limit=${SEARCH_PAGE_SIZE}&market=${market}`,
    );
    if (!result.ok) return [];

    const words = label.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const thisYear = new Date().getFullYear();
    const score = (p: SpotifyPlaylistSummary): number => {
      const name = p.name.toLowerCase();
      const total = p.items?.total ?? p.tracks?.total ?? 0;
      let s = words.filter((w) => name.includes(w)).length * 3;
      if (/\b(hits|greatest|best|classics|all out|all time|top)\b/.test(name)) s += 2;
      // Hitster wants songs people know — not this year's releases or remixes
      if (name.includes(String(thisYear)) || name.includes(String(thisYear + 1)) || /\bnew\b/.test(name)) s -= 3;
      if (/\b(mix|remix|cover|sped up|slowed|karaoke|instrumental|lofi|lo-fi)\b/.test(name)) s -= 4;
      if (total < 30) s -= 5;
      return s;
    };
    return (result.data.playlists?.items ?? [])
      .filter((p): p is SpotifyPlaylistSummary => !!p?.id)
      .filter((p) => score(p) > 0)
      .sort((a, b) => score(b) - score(a));
  }

  /** Deck from the best playlists found for a genre/topic label ("schlager", "90s hip hop"). */
  async getTracksFromPlaylistSearch(label: string, range: YearRange | null): Promise<Card[]> {
    const playlists = (await this.searchPlaylists(label)).slice(0, 2);
    if (playlists.length === 0) return [];
    console.log(`[Spotify] label "${label}" → playlists ${playlists.map((p) => `"${p.name}"`).join(', ')}`);

    const refs: EmbedPlaylistTrack[] = [];
    for (const p of playlists) {
      try {
        refs.push(...(await this.embedPlaylist(p.id)));
      } catch (err) {
        console.warn(`[Spotify] playlist embed ${p.id} failed:`, err instanceof Error ? err.message : err);
      }
    }
    const seen = new Set<string>();
    const unique = refs.filter((r) => {
      if (seen.has(r.trackId)) return false;
      seen.add(r.trackId);
      return true;
    });
    // A decade filter discards some, so look at more
    const candidates = await this.embedCandidates(shuffleArray(unique).slice(0, range ? 110 : 80));
    return this.finalizeDeck(candidates, { range });
  }

  private extractPlaylistId(playlistUrl: string): string {
    const match = playlistUrl.match(/playlist\/([A-Za-z0-9]+)/);
    if (match) return match[1];
    if (/^[A-Za-z0-9]+$/.test(playlistUrl)) return playlistUrl;
    throw new Error(`Cannot extract playlist ID from: ${playlistUrl}`);
  }

  /**
   * Tracks of a Spotify playlist URL or bare ID, read from the public embed page (the Web
   * API refuses playlist contents to dev-mode apps). The embed lists up to 100 tracks.
   */
  async getPlaylistTracks(playlistUrl: string, limit = DECK_SIZE): Promise<Card[]> {
    const playlistId = this.extractPlaylistId(playlistUrl);
    const refs = await this.embedPlaylist(playlistId);
    const candidates = await this.embedCandidates(shuffleArray(refs).slice(0, Math.ceil(limit * 1.3)));
    const cards = await this.finalizeDeck(candidates, { limit });
    console.log(`[Spotify] playlist ${playlistId}: ${refs.length} listed, ${cards.length} cards`);
    return cards;
  }

  // ── Public deck API ────────────────────────────────────────────────────────

  /**
   * Unified method used by the game engine to build a deck.
   * Accepts a Spotify playlist URL, a decade ("80s", "1990-1999"), a genre/topic, or both.
   * In TEST_MODE returns shuffled mock tracks without hitting the API.
   */
  async getTracksForLabel(label: string): Promise<Card[]> {
    if (this.testMode) return shuffleArray(MOCK_TRACKS.map((c) => this.withMockGenres(c)));

    if (/playlist\/[A-Za-z0-9]+/.test(label)) {
      const cards = await this.getPlaylistTracks(label);
      this.assertMinTracks(cards, label);
      return shuffleArray(cards);
    }

    const { range, topic } = parseLabel(label);
    let cards: Card[];
    if (!topic) {
      cards = await this.getTracksForYears(range ? [range] : DEFAULT_DECADES);
    } else {
      cards = await this.getTracksFromPlaylistSearch(label, range);
      if (cards.length < 20 && range) {
        // Too few genre matches for that decade (or API unavailable) — fill with the decade's hits
        const extra = await this.getTracksForYears([range], DECK_SIZE - cards.length);
        const have = new Set(cards.map((c) => songKey(c.title, c.artist)));
        cards = [...cards, ...extra.filter((c) => !have.has(songKey(c.title, c.artist)))];
      }
      if (cards.length < MIN_PLAYABLE_TRACKS && this.isApiBlocked()) {
        throw new Error(
          'Spotify search is temporarily unavailable (request limit reached). Decades like "80s" or a playlist link still work.',
        );
      }
    }

    this.assertMinTracks(cards, label);
    return shuffleArray(cards);
  }

  /** Mixed-era deck when no playlist or genre is specified. */
  async getRandomTracks(count: number): Promise<Card[]> {
    if (this.testMode) return shuffleArray(MOCK_TRACKS).slice(0, count);
    const cards = await this.getTracksForYears(DEFAULT_DECADES, count);
    return shuffleArray(cards).slice(0, count);
  }

  private assertMinTracks(cards: Card[], label: string): void {
    if (cards.length < MIN_PLAYABLE_TRACKS) {
      throw new Error(
        `Only ${cards.length} playable tracks found for "${label}" (need at least ${MIN_PLAYABLE_TRACKS}). Try a different playlist or genre.`,
      );
    }
  }
}

/** Build a SpotifyClient from environment variables. Throws if credentials are absent (unless TEST_MODE). */
export function createSpotifyClient(): SpotifyClient {
  const testMode = process.env.TEST_MODE === 'true';
  const clientId = process.env.SPOTIFY_CLIENT_ID ?? (testMode ? 'test' : '');
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET ?? (testMode ? 'test' : '');
  if (!testMode && (!clientId || !clientSecret)) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  }
  return new SpotifyClient(clientId, clientSecret, testMode);
}
