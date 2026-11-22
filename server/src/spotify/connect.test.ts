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

  it('keeps the UI language of the login for the result page (German by default)', () => {
    const connect = new SpotifyConnect('id', 'secret', fakeFetch({}).fn);
    const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
    expect(connect.takeLogin(stateOf(connect.beginLogin('ROOM', 'owner', 'https://x/cb', 'en')))?.lang).toBe('en');
    expect(connect.takeLogin(stateOf(connect.beginLogin('ROOM', 'owner', 'https://x/cb')))?.lang).toBe('de');
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
    await expect(connect.completeLogin(connect.takeLogin(state)!, 'code')).rejects.toMatchObject({ code: 'not_premium' });
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

  it('remembers a login: the sealed blob links a new room without a Spotify login', async () => {
    const f = fakeFetch({
      'POST accounts.spotify.com/api/token': [
        { status: 200, body: TOKEN },
        { status: 200, body: { access_token: 'at2', expires_in: 3600 } },
      ],
      'GET /v1/me': [{ status: 200, body: { id: 'alice', display_name: 'Alice', product: 'premium' } }],
    });
    const connect = new SpotifyConnect('id', 'secret', f.fn);
    const state = new URL(connect.beginLogin('ROOM', 'p2', 'https://x/cb')).searchParams.get('state')!;
    const saved = await connect.completeLogin(connect.takeLogin(state)!, 'code');
    expect(saved.accountName).toBe('Alice');
    // Opaque to the browser: the refresh token is not readable
    expect(Buffer.from(saved.link, 'base64url').toString('latin1')).not.toContain('refreshToken');

    const restored = await connect.restoreLogin('NEXT', saved.link);
    expect(restored.accountName).toBe('Alice');
    expect(connect.isLinked('NEXT')).toBe(true);
    const refresh = f.calls.filter(c => c.url.includes('/api/token'))[1];
    expect(refresh.body).toContain('refresh_token=rt');
  });

  it('rejects a tampered, foreign or revoked saved login', async () => {
    const { connect } = await linked({});
    const other = new SpotifyConnect('id', 'other-secret', fakeFetch({}).fn);
    await expect(connect.restoreLogin('X', 'garbage')).rejects.toMatchObject({ code: 'expired' });

    const f = fakeFetch({
      'POST accounts.spotify.com/api/token': [{ status: 200, body: TOKEN }, { status: 400, body: { error: 'invalid_grant' } }],
      'GET /v1/me': [{ status: 200, body: { id: 'alice', display_name: 'Alice', product: 'premium' } }],
    });
    const c2 = new SpotifyConnect('id', 'secret', f.fn);
    const state = new URL(c2.beginLogin('ROOM', 'p1', 'https://x/cb')).searchParams.get('state')!;
    const saved = await c2.completeLogin(c2.takeLogin(state)!, 'code');
    await expect(other.restoreLogin('X', saved.link)).rejects.toMatchObject({ code: 'expired' });
    await expect(c2.restoreLogin('X', saved.link)).rejects.toMatchObject({ code: 'expired' });
    expect(c2.isLinked('X')).toBe(false);
  });

  it('hands the TV a player token only when the login allows streaming', async () => {
    const withScope = await linked({});
    // TOKEN has no scope field → unknown, allowed
    await expect(withScope.connect.playerToken('ROOM')).resolves.toMatchObject({ accessToken: 'at' });

    const f = fakeFetch({
      'POST accounts.spotify.com/api/token': [{ status: 200, body: { ...TOKEN, scope: 'user-modify-playback-state' } }],
      'GET /v1/me': [{ status: 200, body: { id: 'alice', display_name: 'Alice', product: 'premium' } }],
    });
    const old = new SpotifyConnect('id', 'secret', f.fn);
    const state = new URL(old.beginLogin('ROOM', 'p1', 'https://x/cb')).searchParams.get('state')!;
    await old.completeLogin(old.takeLogin(state)!, 'code');
    await expect(old.playerToken('ROOM')).rejects.toMatchObject({ code: 'missing_scope' });
    await expect(old.playerToken('NONE')).rejects.toThrow('No Spotify account linked');
  });

  it('asks Spotify for the streaming scope (TV playback in the browser)', () => {
    const connect = new SpotifyConnect('id', 'secret', fakeFetch({}).fn);
    const scope = new URL(connect.beginLogin('ROOM', 'p1', 'https://x/cb')).searchParams.get('scope')!;
    expect(scope.split(' ')).toEqual(expect.arrayContaining(['streaming', 'user-read-email']));
  });
});
