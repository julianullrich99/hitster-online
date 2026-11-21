import { SpotifyConnect } from './connect';

interface Call {
  url: string;
  method: string;
  body?: string;
}

/** Fake fetch: answers by "METHOD path-prefix", records every call. */
function fakeFetch(routes: Record<string, Array<{ status: number; body?: unknown }>>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    // Most specific route wins ('/me/player/devices' over '/v1/me')
    const key = Object.keys(routes)
      .filter(k => {
        const [m, prefix] = k.split(' ');
        return m === method && url.includes(prefix);
      })
      .sort((a, b) => b.length - a.length)[0];
    const queue = key ? routes[key] : undefined;
    const next = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (!next) throw new Error(`unexpected ${method} ${url}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fn, calls };
}

const TOKEN = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };

async function linked(routes: Record<string, Array<{ status: number; body?: unknown }>>) {
  const f = fakeFetch({
    'POST accounts.spotify.com/api/token': [{ status: 200, body: TOKEN }],
    'GET /v1/me': [{ status: 200, body: { id: 'alice', display_name: 'Alice', product: 'premium' } }],
    ...routes,
  });
  const connect = new SpotifyConnect('id', 'secret', f.fn);
  const state = new URL(connect.beginLogin('ROOM', 'owner', 'https://x/cb')).searchParams.get('state')!;
  const login = connect.takeLogin(state)!;
  await connect.completeLogin(login, 'code');
  return { connect, calls: f.calls };
}

describe('SpotifyConnect', () => {
  it('login state is single-use', () => {
    const connect = new SpotifyConnect('id', 'secret', fakeFetch({}).fn);
    const state = new URL(connect.beginLogin('ROOM', 'owner', 'https://x/cb')).searchParams.get('state')!;
    expect(connect.takeLogin(state)?.roomCode).toBe('ROOM');
    expect(connect.takeLogin(state)).toBeNull();
  });

  it('links a Premium account and returns its name', async () => {
    const { connect } = await linked({});
    expect(connect.isLinked('ROOM')).toBe(true);
  });

  it('rejects accounts without Premium', async () => {
    const f = fakeFetch({
      'POST accounts.spotify.com/api/token': [{ status: 200, body: TOKEN }],
      'GET /v1/me': [{ status: 200, body: { id: 'bob', display_name: 'Bob', product: 'free' } }],
    });
    const connect = new SpotifyConnect('id', 'secret', f.fn);
    const state = new URL(connect.beginLogin('ROOM', 'owner', 'https://x/cb')).searchParams.get('state')!;
    await expect(connect.completeLogin(connect.takeLogin(state)!, 'code')).rejects.toThrow('Premium');
    expect(connect.isLinked('ROOM')).toBe(false);
  });

  it('plays the track from the start on the chosen device', async () => {
    const { connect, calls } = await linked({ 'PUT /me/player/play': [{ status: 204 }] });
    await connect.play('ROOM', 'dev1', 'abc');
    const play = calls.find(c => c.url.includes('/me/player/play'))!;
    expect(play.url).toContain('device_id=dev1');
    expect(JSON.parse(play.body!)).toEqual({ uris: ['spotify:track:abc'], position_ms: 0 });
  });

  it('wakes a sleeping device with a transfer and retries once', async () => {
    const { connect, calls } = await linked({
      'PUT /me/player/play': [{ status: 404 }, { status: 204 }],
      'PUT /me/player': [{ status: 204 }],
    });
    await connect.play('ROOM', 'dev1', 'abc');
    expect(calls.filter(c => c.url.includes('/me/player/play'))).toHaveLength(2);
    expect(calls.some(c => c.url.endsWith('/me/player') && c.method === 'PUT')).toBe(true);
  });

  it('throws when playback keeps failing (caller falls back to previews)', async () => {
    const { connect } = await linked({ 'PUT /me/player/play': [{ status: 403 }] });
    await expect(connect.play('ROOM', 'dev1', 'abc')).rejects.toThrow('403');
  });

  it('lists usable devices only', async () => {
    const { connect } = await linked({
      'GET /me/player/devices': [{
        status: 200,
        body: {
          devices: [
            { id: 'p', name: 'Phone', type: 'Smartphone', is_active: true, is_restricted: false },
            { id: null, name: 'Ghost', type: 'Speaker', is_active: false, is_restricted: false },
            { id: 'r', name: 'Locked', type: 'Speaker', is_active: false, is_restricted: true },
          ],
        },
      }],
    });
    expect(await connect.listDevices('ROOM')).toEqual([{ id: 'p', name: 'Phone', type: 'Smartphone', isActive: true }]);
  });

  it('refreshes an expired access token', async () => {
    const f = fakeFetch({
      'POST accounts.spotify.com/api/token': [
        { status: 200, body: { ...TOKEN, expires_in: 0 } },
        { status: 200, body: { access_token: 'fresh', expires_in: 3600 } },
      ],
      'GET /v1/me': [{ status: 200, body: { id: 'a', display_name: 'A', product: 'premium' } }],
      'PUT /me/player/play': [{ status: 204 }],
    });
    const connect = new SpotifyConnect('id', 'secret', f.fn);
    const state = new URL(connect.beginLogin('ROOM', 'owner', 'https://x/cb')).searchParams.get('state')!;
    await connect.completeLogin(connect.takeLogin(state)!, 'code');
    await connect.play('ROOM', 'dev1', 'abc');
    const tokenCalls = f.calls.filter(c => c.url.includes('/api/token'));
    expect(tokenCalls[1].body).toContain('grant_type=refresh_token');
  });
});
