# Deploy to Fly.io

Hitster runs as **one Fly Machine**: Node serves the API, Socket.io, and the built React app from the same origin. In-memory rooms require **`min_machines_running = 1`** (already set in `fly.toml`).

## Prerequisites

- [Fly CLI](https://fly.io/docs/hands-on/install-flyctl/): `brew install flyctl`
- Fly account: `fly auth login`
- Spotify app credentials ([developer.spotify.com/dashboard](https://developer.spotify.com/dashboard))

## First-time setup

From the repo root:

```bash
# Create the app (once). Skip if fly.toml already linked.
fly apps create hitster-online

# Secrets — replace with your values. CLIENT_URL must match the public Fly URL.
fly secrets set \
  SPOTIFY_CLIENT_ID=your_id \
  SPOTIFY_CLIENT_SECRET=your_secret \
  CLIENT_URL=https://hitster-online.fly.dev
```

If you use a custom hostname, set `CLIENT_URL` to that HTTPS origin.

## Deploy

```bash
fly deploy
```

Open `https://hitster-online.fly.dev` (or `fly open`).

## Verify

```bash
fly status
curl https://hitster-online.fly.dev/health
```

## Logs

```bash
fly logs
```

## Cost (approximate)

- **shared-cpu-1x, 512 MB, always on:** about **$3–8/month** depending on region and egress
- Fly may include trial credits for new accounts; check [pricing](https://fly.io/docs/about/pricing/)

## Do not scale to multiple machines yet

Rooms and decks live in **process memory**. Running more than one Machine without Redis will split game state. Keep `min_machines_running = 1`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPOTIFY_CLIENT_ID` | Yes | Spotify Client Credentials |
| `SPOTIFY_CLIENT_SECRET` | Yes | Spotify Client Credentials |
| `CLIENT_URL` | Yes | Public app URL, e.g. `https://hitster-online.fly.dev` (Socket.io CORS) |
| `PORT` | Set in `fly.toml` | `8080` (Fly maps HTTP to this) |
| `TEST_MODE` | No | Leave unset in production |
| `SPOTIFY_REDIRECT_URI` | No | Override for the full-songs login callback (default: `<request origin>/api/spotify/connect/callback`) |

### Full songs (Spotify Connect)

In the Spotify dashboard of the app: add the redirect URI `https://<app>.fly.dev/api/spotify/connect/callback`, and add every Spotify account that should be able to connect under **User Management** (development mode allows 5). Those accounts need Premium.

## Local Docker smoke test

```bash
docker build -t hitster-online .
docker run --rm -p 8080:8080 \
  -e SPOTIFY_CLIENT_ID=... \
  -e SPOTIFY_CLIENT_SECRET=... \
  -e CLIENT_URL=http://localhost:8080 \
  hitster-online
```

Then open http://localhost:8080

## Migrating from Railway

1. Set the same secrets on Fly (`fly secrets set`).
2. Point DNS or share the new Fly URL with players.
3. Railway can stay as fallback until you cut over.

`railway.toml` is unchanged; Fly uses `Dockerfile` + `fly.toml`.
