import { SpotifyClient, createSpotifyClient } from './client';

const mockFetch = jest.fn();
global.fetch = mockFetch as typeof fetch;

// ── fake Spotify ─────────────────────────────────────────────────────────────
// Routes requests by URL so parallel lookups don't depend on call order.

const ALL_OUT_80S = '37i9dQZF1DX4UtSsGT1Sbe';

interface FakeTrack {
  id: string;
  title: string;
  artist: string;
  date: string;
}

/** Spotify-shaped 22-char playlist id */
function pid(name: string): string {
  return name.padEnd(22, '0');
}

function trackId(n: number): string {
  return `t${String(n).padStart(21, '0')}`;
}

function nextData(entity: unknown): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script></html>`;
}

function playlistEmbedHtml(tracks: FakeTrack[]): string {
  return nextData({
    trackList: tracks.map(t => ({
      uri: `spotify:track:${t.id}`,
      title: t.title,
      subtitle: t.artist,
      audioPreview: { url: `https://p.scdn.co/mp3-preview/${t.id}` },
    })),
  });
}

function trackEmbedHtml(t: FakeTrack): string {
  return nextData({
    id: t.id,
    name: t.title,
    artists: [{ name: t.artist }],
    releaseDate: { isoString: `${t.date}T00:00:00Z` },
    audioPreview: { url: `https://p.scdn.co/mp3-preview/${t.id}` },
    visualIdentity: { image: [{ url: `https://img/${t.id}-64`, maxWidth: 64 }, { url: `https://img/${t.id}-640`, maxWidth: 640 }] },
  });
}

function html(body: string, status = 200) {
  return { ok: status < 400, status, text: async () => body, headers: { get: () => null } };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status < 400,
    status,
    statusText: 'x',
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  };
}

function apiTrack(t: FakeTrack, albumName = 'Album') {
  return {
    id: t.id,
    name: t.title,
    artists: [{ id: 'a', name: t.artist }],
    preview_url: null,
    album: { name: albumName, album_type: 'album', images: [], release_date: t.date },
  };
}

interface FakeSpotify {
  playlists: Record<string, FakeTrack[]>;
  /** /search?type=playlist results */
  playlistSearch?: Array<{ id: string; name: string; total: number }>;
  /** /search?type=track results keyed by a substring of the decoded query */
  trackSearch?: Record<string, FakeTrack[]>;
  apiStatus?: number;
  apiHeaders?: Record<string, string>;
  embedStatus?: number;
}

function installFakeSpotify(fake: FakeSpotify) {
  const tracks = new Map<string, FakeTrack>();
  for (const list of Object.values(fake.playlists)) for (const t of list) tracks.set(t.id, t);

  mockFetch.mockImplementation(async (url: string) => {
    if (url === 'https://accounts.spotify.com/api/token') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    const embedPlaylist = url.match(/open\.spotify\.com\/embed\/playlist\/(\w+)/);
    if (embedPlaylist) {
      if (fake.embedStatus) return html('', fake.embedStatus);
      return html(playlistEmbedHtml(fake.playlists[embedPlaylist[1]] ?? []));
    }
    const embedTrack = url.match(/open\.spotify\.com\/embed\/track\/(\w+)/);
    if (embedTrack) {
      if (fake.embedStatus) return html('', fake.embedStatus);
      const t = tracks.get(embedTrack[1]);
      return t ? html(trackEmbedHtml(t)) : html('', 404);
    }
    if (url.startsWith('https://api.spotify.com/v1/search')) {
      if (fake.apiStatus) return json({}, fake.apiStatus, fake.apiHeaders);
      const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '');
      if (url.includes('type=playlist')) {
        return json({
          playlists: {
            items: (fake.playlistSearch ?? []).map(p => ({ id: p.id, name: p.name, items: { total: p.total } })),
          },
        });
      }
      const hit = Object.entries(fake.trackSearch ?? {}).find(([needle]) => q.includes(needle));
      return json({ tracks: { items: (hit?.[1] ?? []).map(t => apiTrack(t)) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function decade(from: number, count: number, offset = 0): FakeTrack[] {
  return Array.from({ length: count }, (_, i) => ({
    id: trackId(offset + i),
    title: `Song ${offset + i}`,
    artist: `Artist ${offset + i}`,
    date: `${from + (i % 10)}-05-01`,
  }));
}

function apiCalls(): string[] {
  return mockFetch.mock.calls.map(([u]) => u as string).filter(u => u.startsWith('https://api.spotify.com'));
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('SpotifyClient', () => {
  let client: SpotifyClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new SpotifyClient('test-id', 'test-secret');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  // ── token management ────────────────────────────────────────────────────────

  describe('token management', () => {
    it('fetches an access token with Client Credentials and reuses it', async () => {
      installFakeSpotify({ playlists: {}, playlistSearch: [] });

      await client.searchPlaylists('rock');
      await client.searchPlaylists('jazz');

      const tokenCalls = mockFetch.mock.calls.filter(([url]) => url === 'https://accounts.spotify.com/api/token');
      expect(tokenCalls).toHaveLength(1);
      const init = tokenCalls[0][1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(init.body).toBe('grant_type=client_credentials');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('test-id:test-secret').toString('base64')}`,
      );
    });

    it('throws when the token request fails', async () => {
      mockFetch.mockResolvedValueOnce(json({}, 401));
      await expect(client.searchPlaylists('rock')).rejects.toThrow('Spotify token request failed: 401');
    });
  });

  // ── decade decks ───────────────────────────────────────────────────────────

  describe('decade labels', () => {
    it('builds "80s" from the All Out 80s playlist via embed pages, without the Web API', async () => {
      installFakeSpotify({ playlists: { [ALL_OUT_80S]: decade(1980, 80) } });

      const cards = await client.getTracksForLabel('80s');

      expect(cards.length).toBeGreaterThanOrEqual(50);
      expect(cards.every(c => c.releaseYear >= 1980 && c.releaseYear <= 1989)).toBe(true);
      expect(cards[0].streamUrl).toMatch(/^https:\/\/p\.scdn\.co\/mp3-preview\//);
      expect(cards[0].albumArt).toMatch(/-640$/);
      expect(apiCalls()).toHaveLength(0);
    });

    it('drops tracks dated outside the decade (re-releases)', async () => {
      const tracks = decade(1980, 20);
      tracks[0] = { ...tracks[0], title: 'Dreams - 2004 Remaster', date: '2004-01-01' };
      installFakeSpotify({ playlists: { [ALL_OUT_80S]: tracks } });

      const cards = await client.getTracksForLabel('80er');

      expect(cards.find(c => c.trackId === tracks[0].id)).toBeUndefined();
      expect(cards).toHaveLength(19);
    });
  });

  // ── playlist links ─────────────────────────────────────────────────────────

  describe('playlist URLs', () => {
    it('reads the playlist from its embed page and cleans version suffixes from titles', async () => {
      const tracks = decade(1990, 10, 100);
      tracks[0] = { ...tracks[0], title: 'Wonderwall - Remastered' };
      installFakeSpotify({ playlists: { [pid('PL1')]: tracks } });

      const cards = await client.getTracksForLabel(`https://open.spotify.com/playlist/${pid('PL1')}?si=x`);

      expect(cards.map(c => c.title)).not.toContain('Wonderwall - Remastered');
      expect(apiCalls().every(u => !u.includes('/playlists/'))).toBe(true);
    });

    it('looks up the original year of a remaster when no decade bounds the deck', async () => {
      const remaster = { id: trackId(500), title: 'Hotel California - 2013 Remaster', artist: 'Eagles', date: '2013-04-26' };
      installFakeSpotify({
        playlists: { [pid('PL2')]: [remaster, ...decade(1970, 9, 501)] },
        trackSearch: {
          'track:"Hotel California"': [
            { ...remaster, date: '2013-04-26' },
            { ...remaster, id: trackId(599), date: '1976-12-08' },
          ],
        },
      });

      const cards = await client.getTracksForLabel(`https://open.spotify.com/playlist/${pid('PL2')}`);
      const card = cards.find(c => c.trackId === remaster.id);

      expect(card?.releaseYear).toBe(1976);
      expect(card?.title).toBe('Hotel California');
    });
  });

  // ── genre / topic labels ───────────────────────────────────────────────────

  describe('topic labels', () => {
    it('uses the best-matching playlist from playlist search', async () => {
      installFakeSpotify({
        playlists: { [pid('GOOD')]: decade(1990, 40, 200), [pid('MIX')]: decade(2020, 40, 300) },
        playlistSearch: [
          { id: pid('MIX'), name: 'Schlager Party Mix 2026', total: 100 },
          { id: pid('GOOD'), name: 'Die größten Schlager Hits', total: 120 },
        ],
      });

      const cards = await client.getTracksForLabel('Schlager');

      expect(cards.length).toBeGreaterThan(0);
      expect(cards.every(c => c.releaseYear < 2000)).toBe(true);
    });

    it('applies the decade from "90s hip hop" to playlist tracks', async () => {
      installFakeSpotify({
        playlists: { [pid('HH')]: [...decade(1990, 30, 400), ...decade(2010, 30, 430)] },
        playlistSearch: [{ id: pid('HH'), name: '90s Hip Hop Hits', total: 60 }],
      });

      const cards = await client.getTracksForLabel('90s hip hop');

      expect(cards.length).toBeGreaterThanOrEqual(20);
      expect(cards.every(c => c.releaseYear >= 1990 && c.releaseYear <= 1999)).toBe(true);
    });
  });

  // ── quota / throttling ─────────────────────────────────────────────────────

  describe('rate limits', () => {
    it('stops calling the API after a quota 429 and explains it for topic labels', async () => {
      installFakeSpotify({ playlists: {}, apiStatus: 429, apiHeaders: { 'retry-after': '36000' } });

      await expect(client.getTracksForLabel('Schlager')).rejects.toThrow(/temporarily unavailable/);
      const callsAfterFirst = apiCalls().length;
      await expect(client.getTracksForLabel('Rock')).rejects.toThrow(/temporarily unavailable/);

      expect(client.isApiBlocked()).toBe(true);
      expect(apiCalls()).toHaveLength(callsAfterFirst);
    });

    it('decade decks keep working while the API quota is exhausted', async () => {
      installFakeSpotify({ playlists: { [ALL_OUT_80S]: decade(1980, 60) }, apiStatus: 429, apiHeaders: { 'retry-after': '36000' } });

      await expect(client.getTracksForLabel('Schlager')).rejects.toThrow();
      const cards = await client.getTracksForLabel('80s');

      expect(cards.length).toBeGreaterThanOrEqual(50);
    });

    it('serves cached embed data and skips new embed requests while throttled', async () => {
      installFakeSpotify({ playlists: { [ALL_OUT_80S]: decade(1980, 60) } });
      await client.getTracksForLabel('80s');

      installFakeSpotify({ playlists: { [ALL_OUT_80S]: decade(1980, 60) }, embedStatus: 429 });
      mockFetch.mockClear();
      const cards = await client.getTracksForLabel('80s');

      expect(cards.length).toBeGreaterThanOrEqual(50);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // ── createSpotifyClient ─────────────────────────────────────────────────────

  describe('createSpotifyClient', () => {
    const origId = process.env.SPOTIFY_CLIENT_ID;
    const origSecret = process.env.SPOTIFY_CLIENT_SECRET;

    afterEach(() => {
      if (origId) process.env.SPOTIFY_CLIENT_ID = origId;
      else delete process.env.SPOTIFY_CLIENT_ID;
      if (origSecret) process.env.SPOTIFY_CLIENT_SECRET = origSecret;
      else delete process.env.SPOTIFY_CLIENT_SECRET;
    });

    it('throws when env vars are missing', () => {
      delete process.env.SPOTIFY_CLIENT_ID;
      delete process.env.SPOTIFY_CLIENT_SECRET;
      expect(() => createSpotifyClient()).toThrow('SPOTIFY_CLIENT_ID');
    });

    it('returns a SpotifyClient when env vars are present', () => {
      process.env.SPOTIFY_CLIENT_ID = 'id';
      process.env.SPOTIFY_CLIENT_SECRET = 'secret';
      expect(createSpotifyClient()).toBeInstanceOf(SpotifyClient);
    });
  });
});
