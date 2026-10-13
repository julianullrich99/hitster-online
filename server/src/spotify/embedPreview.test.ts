import {
  extractEmbedPlaylistTracks,
  extractEmbedTrack,
  extractEmbedPreviewUrl,
  fetchEmbedPreviewUrl,
  isValidSpotifyTrackId,
} from './embedPreview';

const SAMPLE_HTML = `<!DOCTYPE html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  props: {
    pageProps: {
      state: {
        data: {
          entity: {
            audioPreview: {
              url: 'https://p.scdn.co/mp3-preview/c5fcaf1d5684a65cbb2ba343f19ccdc328721d54',
            },
          },
        },
      },
    },
  },
})}</script></body></html>`;

describe('extractEmbedPreviewUrl', () => {
  it('returns mp3-preview URL from __NEXT_DATA__', () => {
    expect(extractEmbedPreviewUrl(SAMPLE_HTML)).toBe(
      'https://p.scdn.co/mp3-preview/c5fcaf1d5684a65cbb2ba343f19ccdc328721d54',
    );
  });

  it('returns null when __NEXT_DATA__ is missing', () => {
    expect(extractEmbedPreviewUrl('<html></html>')).toBeNull();
  });

  it('returns null when audioPreview is missing', () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { state: { data: { entity: {} } } } },
    })}</script>`;
    expect(extractEmbedPreviewUrl(html)).toBeNull();
  });

  it('rejects non-preview URLs', () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          state: {
            data: {
              entity: { audioPreview: { url: 'https://open.spotify.com/track/abc' } },
            },
          },
        },
      },
    })}</script>`;
    expect(extractEmbedPreviewUrl(html)).toBeNull();
  });
});

describe('isValidSpotifyTrackId', () => {
  it('accepts 22-char alphanumeric ids', () => {
    expect(isValidSpotifyTrackId('25FTMokYEbEWHEdss5JLZS')).toBe(true);
  });

  it('rejects invalid ids', () => {
    expect(isValidSpotifyTrackId('short')).toBe(false);
    expect(isValidSpotifyTrackId('')).toBe(false);
  });
});

describe('fetchEmbedPreviewUrl', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches embed HTML and extracts preview URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => SAMPLE_HTML,
    });

    const url = await fetchEmbedPreviewUrl('25FTMokYEbEWHEdss5JLZS');
    expect(url).toBe(
      'https://p.scdn.co/mp3-preview/c5fcaf1d5684a65cbb2ba343f19ccdc328721d54',
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://open.spotify.com/embed/track/25FTMokYEbEWHEdss5JLZS?utm_source=generator',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });

  it('throws on invalid track id', async () => {
    await expect(fetchEmbedPreviewUrl('bad')).rejects.toThrow('Invalid Spotify track ID');
  });
});

function embedHtml(entity: unknown): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script>`;
}

describe('extractEmbedPlaylistTracks', () => {
  it('lists tracks with preview URLs and skips invalid entries', () => {
    const html = embedHtml({
      trackList: [
        { uri: 'spotify:track:2WfaOiMkCvy7F5fcp2zZ8L', title: 'Take on Me', subtitle: 'a-ha', audioPreview: { url: 'https://p.scdn.co/mp3-preview/abc' } },
        { uri: 'spotify:episode:xyz', title: 'Podcast' },
        { uri: 'spotify:track:0000000000000000000001', title: 'No preview', subtitle: 'X' },
      ],
    });
    expect(extractEmbedPlaylistTracks(html)).toEqual([
      { trackId: '2WfaOiMkCvy7F5fcp2zZ8L', title: 'Take on Me', artist: 'a-ha', previewUrl: 'https://p.scdn.co/mp3-preview/abc' },
      { trackId: '0000000000000000000001', title: 'No preview', artist: 'X', previewUrl: null },
    ]);
  });

  it('returns [] for pages without data', () => {
    expect(extractEmbedPlaylistTracks('<html></html>')).toEqual([]);
  });
});

describe('extractEmbedTrack', () => {
  it('reads title, artists, year, largest cover and preview', () => {
    const html = embedHtml({
      id: '2374M0fQpWi3dLnB54qaLX',
      name: 'Africa',
      artists: [{ name: 'TOTO' }],
      releaseDate: { isoString: '1982-04-08T00:00:00Z' },
      audioPreview: { url: 'https://p.scdn.co/mp3-preview/e73' },
      visualIdentity: { image: [{ url: 'small', maxWidth: 64 }, { url: 'big', maxWidth: 640 }] },
    });
    expect(extractEmbedTrack(html)).toEqual({
      trackId: '2374M0fQpWi3dLnB54qaLX',
      title: 'Africa',
      artists: ['TOTO'],
      releaseYear: 1982,
      albumArt: 'big',
      previewUrl: 'https://p.scdn.co/mp3-preview/e73',
    });
  });
});
