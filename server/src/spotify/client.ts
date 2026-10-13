import { Card } from '@shared/types';
import { MOCK_TRACKS } from './mockTracks';

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  preview_url: string | null;
  popularity?: number;
  external_urls?: { spotify?: string };
  album: {
    images: Array<{ url: string; width: number; height: number }>;
    release_date: string;
    release_date_precision: 'year' | 'month' | 'day';
  };
}

interface PlaylistTracksPage {
  items: Array<{ track: SpotifyTrack | null }>;
  next: string | null;
}

interface SearchTracksPage {
  tracks: {
    items: SpotifyTrack[];
    next: string | null;
  };
}

interface RecommendationsPage {
  tracks: SpotifyTrack[];
}

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const MIN_PLAYABLE_TRACKS = 6;
const DEFAULT_MIN_POPULARITY = 70;
const DEFAULT_MARKET = 'US';
const MAX_RECOMMENDATIONS = 100;

/** Spotify seed_genres values (subset + aliases). See GET /recommendations/available-genre-seeds */
const SPOTIFY_SEED_GENRES = new Set([
  'acoustic', 'afrobeat', 'alt-rock', 'alternative', 'ambient', 'anime', 'blues', 'bossanova',
  'classical', 'club', 'country', 'dance', 'dancehall', 'deep-house', 'disco', 'drum-and-bass',
  'dub', 'dubstep', 'electronic', 'folk', 'funk', 'garage', 'gospel', 'grunge', 'guitar',
  'happy', 'heavy-metal', 'hip-hop', 'house', 'indie', 'indie-pop', 'jazz', 'k-pop', 'latin',
  'metal', 'new-age', 'opera', 'party', 'piano', 'pop', 'punk', 'r-n-b', 'reggae', 'rock',
  'salsa', 'samba', 'singer-songwriter', 'soul', 'spanish', 'study', 'summer', 'synth-pop',
  'tango', 'techno', 'trance', 'trip-hop', 'turkish', 'world-music',
]);

/** Friendly playlist labels → up to 5 Spotify seed_genres */
const GENRE_LABEL_SEEDS: Record<string, string[]> = {
  '90s rock': ['rock'],
  "90's rock": ['rock'],
  '80s pop': ['pop'],
  '70s disco': ['disco'],
  '60s rock': ['rock'],
  '2000s pop': ['pop'],
  "2010's edm": ['electronic', 'dance'],
  '2020s hits': ['pop'],
  'y2k pop': ['pop'],
  'classic rock': ['rock'],
  'hard rock': ['rock'],
  'soft rock': ['rock'],
  'alternative rock': ['alt-rock', 'rock'],
  'indie rock': ['indie', 'rock'],
  'grunge': ['grunge', 'rock'],
  'punk rock': ['punk', 'rock'],
  'pop punk': ['punk', 'pop'],
  'emo': ['rock', 'punk'],
  'metal': ['metal'],
  'heavy metal': ['heavy-metal', 'metal'],
  'pop': ['pop'],
  'dance pop': ['pop', 'dance'],
  'synth pop': ['synth-pop', 'pop'],
  'new wave': ['synth-pop'],
  'teen pop': ['pop'],
  'k-pop': ['k-pop'],
  'j-pop': ['anime', 'pop'],
  'latin pop': ['latin', 'pop'],
  'reggaeton': ['latin', 'dance'],
  'salsa': ['salsa', 'latin'],
  'bachata': ['latin'],
  'afrobeats': ['afrobeat'],
  'dancehall': ['dancehall'],
  'hip hop': ['hip-hop'],
  'rap': ['hip-hop'],
  'old school hip hop': ['hip-hop'],
  'trap': ['hip-hop'],
  'r&b': ['r-n-b'],
  'rnb': ['r-n-b'],
  'soul': ['soul'],
  'funk': ['funk'],
  'disco': ['disco'],
  'house': ['house'],
  'techno': ['techno'],
  'trance': ['trance'],
  'drum and bass': ['drum-and-bass'],
  'dubstep': ['dubstep'],
  'edm': ['electronic', 'dance'],
  'country': ['country'],
  'modern country': ['country'],
  'bluegrass': ['country', 'folk'],
  'folk': ['folk'],
  'americana': ['country', 'folk'],
  'blues': ['blues'],
  'jazz': ['jazz'],
  'smooth jazz': ['jazz'],
  'classical': ['classical'],
  'soundtrack': ['ambient', 'classical'],
  'movie soundtracks': ['ambient', 'classical'],
  'reggae': ['reggae'],
  'ska': ['ska'],
  'britpop': ['indie', 'rock'],
  'motown': ['soul', 'funk'],
  'gospel': ['gospel'],
  'christian': ['gospel'],
  'rock': ['rock'],
  '90s pop': ['pop'],
};

function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class SpotifyClient {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

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

  private minPopularity(): number {
    const n = parseInt(process.env.SPOTIFY_MIN_POPULARITY ?? String(DEFAULT_MIN_POPULARITY), 10);
    return Number.isNaN(n) ? DEFAULT_MIN_POPULARITY : n;
  }

  private spotifyMarket(): string {
    return process.env.SPOTIFY_MARKET ?? DEFAULT_MARKET;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const result = await this.tryApiGet<T>(path);
    if (!result.ok) {
      throw new Error(`Spotify API error ${result.status} for ${path}`);
    }
    return result.data;
  }

  /** Returns status on failure instead of throwing (for optional endpoints like /recommendations). */
  private async tryApiGet<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
    const token = await this.ensureToken();
    const url = path.startsWith('http') ? path : `${SPOTIFY_API_BASE}${path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    return { ok: true, data: (await res.json()) as T };
  }

  private trackArtists(track: SpotifyTrack): string {
    return track.artists.map((a) => a.name).join(', ');
  }

  private trackReleaseYear(track: SpotifyTrack): number | null {
    const year = parseInt(track.album.release_date.slice(0, 4), 10);
    return isNaN(year) ? null : year;
  }

  private trackPlayUrl(track: SpotifyTrack): string {
    return track.external_urls?.spotify ?? `https://open.spotify.com/track/${track.id}`;
  }

  private logRetrievedTrack(track: SpotifyTrack, included: boolean, skipReason?: string): void {
    const year = this.trackReleaseYear(track);
    const parts = [
      `[Spotify]`,
      `id=${track.id}`,
      `year=${year ?? '?'}`,
      `title="${track.name}"`,
      `artist="${this.trackArtists(track)}"`,
      `playUrl=${this.trackPlayUrl(track)}`,
      `previewUrl=${track.preview_url ?? 'null'}`,
      `albumArt=${track.album.images[0]?.url ?? 'none'}`,
      `included=${included}`,
    ];
    if (skipReason) parts.push(`reason=${skipReason}`);
    console.log(parts.join(' '));
  }

  /** Batch-fetch artist genres from Spotify (up to 50 ids per request). */
  private async fetchArtistGenresMap(artistIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const unique = [...new Set(artistIds.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const data = await this.apiGet<{ artists: Array<SpotifyArtist | null> }>(
        `/artists?ids=${batch.join(',')}`,
      );
      for (const artist of data.artists ?? []) {
        if (artist?.id) map.set(artist.id, artist.genres ?? []);
      }
    }
    return map;
  }

  private async attachGenresToCards(
    entries: Array<{ card: Card; artistId: string | undefined }>,
  ): Promise<Card[]> {
    const ids = entries.map((e) => e.artistId).filter((id): id is string => !!id);
    if (ids.length === 0) return entries.map((e) => e.card);

    try {
      const genreMap = await this.fetchArtistGenresMap(ids);
      return entries.map(({ card, artistId }) => {
        const genres = artistId ? genreMap.get(artistId) : undefined;
        if (!genres?.length) return card;
        return { ...card, genres: genres.slice(0, 3) };
      });
    } catch (err) {
      console.warn('[Spotify] artist genre lookup failed:', err);
      return entries.map((e) => e.card);
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

  private tracksToCards(tracks: SpotifyTrack[]): Promise<Card[]> {
    const entries: Array<{ card: Card; artistId: string | undefined }> = [];
    for (const track of tracks) {
      const card = this.trackToCard(track);
      if (card) {
        entries.push({ card, artistId: track.artists[0]?.id });
      }
    }
    return this.attachGenresToCards(entries);
  }

  private trackToCard(track: SpotifyTrack): Card | null {
    const releaseYear = this.trackReleaseYear(track);
    if (releaseYear === null) {
      this.logRetrievedTrack(track, false, 'invalid_release_year');
      return null;
    }

    const albumArt = track.album.images[0]?.url ?? '';

    const card: Card = {
      trackId: track.id,
      title: track.name,
      artist: this.trackArtists(track),
      releaseYear,
      // For now: Spotify play page (external_urls.spotify), not preview_url MP3.
      previewUrl: this.trackPlayUrl(track),
      streamUrl: track.preview_url,
      albumArt,
    };
    this.logRetrievedTrack(track, true);
    return card;
  }

  private extractPlaylistId(playlistUrl: string): string {
    const match = playlistUrl.match(/playlist\/([A-Za-z0-9]+)/);
    if (match) return match[1];
    if (/^[A-Za-z0-9]+$/.test(playlistUrl)) return playlistUrl;
    throw new Error(`Cannot extract playlist ID from: ${playlistUrl}`);
  }

  /** Fetch tracks from a Spotify playlist URL or bare playlist ID. */
  async getPlaylistTracks(playlistUrl: string, limit = 200): Promise<Card[]> {
    const playlistId = this.extractPlaylistId(playlistUrl);
    const raw: SpotifyTrack[] = [];
    let nextPath: string | null = `/playlists/${playlistId}/tracks?limit=50`;

    while (nextPath && raw.length < limit) {
      const data: PlaylistTracksPage = await this.apiGet<PlaylistTracksPage>(nextPath);

      for (const item of data.items) {
        if (!item.track) {
          console.log('[Spotify] skipped null playlist item');
          continue;
        }
        raw.push(item.track);
      }

      nextPath = data.next ?? null;
    }

    const cards = await this.tracksToCards(raw.slice(0, limit));
    console.log(`[Spotify] playlist ${playlistId}: ${cards.length} tracks included`);
    return cards;
  }

  /**
   * Map a user-facing genre/theme label to Spotify recommendation seed_genres (max 5).
   */
  resolveSeedGenres(label: string): string[] {
    const key = label.toLowerCase().trim();
    if (GENRE_LABEL_SEEDS[key]) return GENRE_LABEL_SEEDS[key].slice(0, 5);

    const decadeStripped = key
      .replace(/['']/g, '')
      .replace(/^(19|20)\d{0,2}s?\s+/, '')
      .trim();
    if (GENRE_LABEL_SEEDS[decadeStripped]) return GENRE_LABEL_SEEDS[decadeStripped].slice(0, 5);

    const seeds: string[] = [];
    const add = (g: string) => {
      if (SPOTIFY_SEED_GENRES.has(g) && !seeds.includes(g)) seeds.push(g);
    };

    if (decadeStripped.includes('hip hop') || decadeStripped.includes('hip-hop')) add('hip-hop');
    if (decadeStripped.includes('r&b') || decadeStripped.includes('rnb')) add('r-n-b');
    if (decadeStripped.includes('edm')) add('electronic');
    if (decadeStripped.includes('k pop') || decadeStripped.includes('k-pop')) add('k-pop');

    for (const token of decadeStripped.split(/[\s/,&+]+/).filter(Boolean)) {
      const normalized = token.replace(/[^a-z0-9-]/g, '');
      if (normalized === 'rnb') add('r-n-b');
      else if (normalized === 'hiphop') add('hip-hop');
      else add(normalized);
      if (seeds.length >= 5) break;
    }

    if (seeds.length === 0) {
      console.warn(`[Spotify] unknown genre label "${label}", defaulting seed_genres to pop`);
      return ['pop'];
    }
    return seeds.slice(0, 5);
  }

  /**
   * Popular tracks for a genre via GET /recommendations (seed_genres + min_popularity).
   * Works with Client Credentials; optional market improves preview_url availability.
   */
  async getRecommendationsForGenre(genre: string, limit = 100): Promise<Card[]> {
    if (process.env.SPOTIFY_USE_RECOMMENDATIONS === 'false') {
      return [];
    }

    const seeds = this.resolveSeedGenres(genre);
    const cappedLimit = Math.min(limit, MAX_RECOMMENDATIONS);
    const params = new URLSearchParams({
      seed_genres: seeds.join(','),
      min_popularity: String(this.minPopularity()),
      limit: String(cappedLimit),
      market: this.spotifyMarket(),
    });

    const path = `/recommendations?${params.toString()}`;
    const result = await this.tryApiGet<RecommendationsPage>(path);
    if (!result.ok) {
      if (result.status === 404 || result.status === 403) {
        console.warn(
          `[Spotify] GET /recommendations returned ${result.status} (unavailable for new/dev apps since 2024-11); using search by popularity`,
        );
        return [];
      }
      throw new Error(`Spotify API error ${result.status} for ${path}`);
    }

    const cards = await this.tracksToCards(result.data.tracks ?? []);

    console.log(
      `[Spotify] recommendations genre="${genre}" seeds=${seeds.join(',')} min_popularity=${params.get('min_popularity')}: ${cards.length} tracks included`,
    );
    return cards;
  }

  /**
   * Fallback when /recommendations is blocked: search genre:SEED, filter by popularity, sort desc.
   */
  async searchPopularGenreTracks(genre: string, limit = 100): Promise<Card[]> {
    const seeds = this.resolveSeedGenres(genre);
    const minPop = this.minPopularity();
    const market = this.spotifyMarket();
    const seen = new Set<string>();
    const ranked: SpotifyTrack[] = [];

    for (const seed of seeds) {
      const q = encodeURIComponent(`genre:${seed}`);
      let nextPath: string | null =
        `/search?q=${q}&type=track&limit=10&market=${encodeURIComponent(market)}`;

      for (let page = 0; page < 30 && nextPath && ranked.length < limit * 3; page++) {
        const data: SearchTracksPage = await this.apiGet<SearchTracksPage>(nextPath);
        const items: SpotifyTrack[] = data.tracks?.items ?? [];

        for (const track of items) {
          if (seen.has(track.id)) continue;
          seen.add(track.id);
          const pop = track.popularity ?? 0;
          if (pop >= minPop) ranked.push(track);
        }

        nextPath = items.length === 0 ? null : (data.tracks?.next ?? null);
      }
    }

    ranked.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

    const cards = await this.tracksToCards(ranked.slice(0, limit));

    console.log(
      `[Spotify] search popular genre="${genre}" seeds=${seeds.join(',')} min_popularity=${minPop}: ${cards.length} tracks included`,
    );
    return cards;
  }

  /** Popular tracks for a genre/theme label (recommendations when allowed, else popularity-ranked search). */
  async getGenreTracks(genre: string, limit = 100): Promise<Card[]> {
    return this.getGenreTracksWithFallback(genre, limit);
  }

  /**
   * Unified method used by the game engine to build a deck.
   * Accepts a Spotify playlist URL or a genre keyword.
   * In TEST_MODE returns shuffled mock tracks without hitting the API.
   */
  async getTracksForLabel(label: string): Promise<Card[]> {
    if (this.testMode) return shuffleArray(MOCK_TRACKS.map((c) => this.withMockGenres(c)));

    const playlistMatch = label.match(/playlist\/([A-Za-z0-9]+)/);
    if (playlistMatch) {
      const cards = await this.getPlaylistTracks(label);
      this.assertMinTracks(cards, label);
      return shuffleArray(cards);
    }

    const cards = await this.getGenreTracksWithFallback(label);
    this.assertMinTracks(cards, label);
    return shuffleArray(cards);
  }

  /** Fetch random tracks for when no playlist or genre is specified. */
  async getRandomTracks(count: number): Promise<Card[]> {
    if (this.testMode) return shuffleArray(MOCK_TRACKS).slice(0, count);
    const cards = await this.getGenreTracksWithFallback('pop', count);
    return shuffleArray(cards).slice(0, count);
  }

  /** Recommendations when available; else popularity-ranked genre search; then keyword search. */
  private async getGenreTracksWithFallback(genre: string, limit = 50): Promise<Card[]> {
    const fromRecs = await this.getRecommendationsForGenre(genre, limit);
    if (fromRecs.length >= 10) return fromRecs;

    const fromSearch = await this.searchPopularGenreTracks(genre, limit);
    if (fromSearch.length >= 10) return fromSearch;

    const q = encodeURIComponent(genre);
    const data: SearchTracksPage = await this.apiGet<SearchTracksPage>(
      `/search?q=${q}&type=track&limit=10`,
    );
    const cards = await this.tracksToCards(data.tracks?.items ?? []);
    console.log(`[Spotify] keyword fallback "${genre}": ${cards.length} tracks included`);
    return cards.length > 0 ? cards : fromRecs;
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
