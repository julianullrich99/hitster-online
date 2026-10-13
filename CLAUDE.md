# CLAUDE.md — Hitster Online

This file is read by Claude Code at the start of every session. Read it fully before touching any code.

## Key documents — read these before writing code

| Document | When to read |
|---|---|
| `CLAUDE.md` (this file) | Every session — rules and constraints |
| `docs/ARCHITECTURE.md` | Before adding or changing any server/client module |
| `docs/REQUIREMENTS.md` | Before implementing any game feature |
| `shared/types.ts` | Before defining new event shapes or state fields |
| `CONTRIBUTING.md` | Step-by-step guide for adding features, tests, and events |

---

## What this project is

A browser-based multiplayer implementation of the **Hitster** card game. Players build a chronological timeline of songs by listening to 30-second audio previews and guessing whether each song belongs before or after the ones already on their timeline. First to correctly place 6 cards wins.

The full functional requirements, architecture, and game rules are in `docs/REQUIREMENTS.md`. Read that file if you need detail on game mechanics.

---

## Repo structure

```
/
├── CLAUDE.md              ← you are here
├── CONTRIBUTING.md        ← dev workflow, how to add features and events
├── LICENSE                ← Apache 2.0
├── docs/
│   ├── ARCHITECTURE.md    ← module contracts, data flow, invariants
│   ├── REQUIREMENTS.md    ← full spec, read before building features
│   └── DEPLOY_FLY.md      ← production deployment
├── shared/
│   └── types.ts           ← ALL shared TypeScript types. Define types here first.
├── server/
│   ├── src/
│   │   ├── index.ts       ← entry point, Express + Socket.io setup
│   │   ├── game/          ← game state engine (pure logic, no I/O)
│   │   ├── rooms/         ← room and session management
│   │   └── spotify/       ← Spotify API client (playlist fetch, metadata)
│   ├── package.json
│   └── tsconfig.json
├── client/
│   ├── src/
│   │   ├── components/    ← React UI components
│   │   ├── game/          ← game state hooks and context
│   │   └── socket/        ← Socket.io client setup and event handlers
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
└── bots/
    ├── profiles.yaml      ← bot character definitions (edit to change behaviour)
    ├── index.ts           ← runner: npm start [--room XXXX] [--count N] [--url ...]
    ├── bot.ts             ← single bot client (Socket.io + behaviour model)
    ├── types.ts           ← BotProfile and related types
    ├── package.json
    └── tsconfig.json
```

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS |
| Drag & drop | @dnd-kit/core (timeline card placement) |
| Real-time | Socket.io v4 (client + server) |
| Backend | Node.js + TypeScript, Express |
| External API | Spotify Web API (Client Credentials Flow) |
| State | In-memory only — no database |
| Hosting | Fly.io (see `docs/DEPLOY_FLY.md`; `railway.toml` optional) |

---

## How to run locally

```bash
# Install all dependencies
cd server && npm install
cd ../client && npm install

# Set environment variables (create server/.env)
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
PORT=3000

# Run server (from /server)
npm run dev

# Run client (from /client, in a separate terminal)
npm run dev

# To simulate multiplayer: open multiple browser tabs at http://localhost:5173
```

---

## Architecture rules — read before writing code

### 1. Game state lives on the server only
All game logic (turn order, placement validation, token accounting, win detection) runs in `server/src/game/`. Clients are dumb renderers — they display what the server tells them. **Never put game logic in the client.**

### 2. Define types before writing logic
Before adding a new feature or event, define its TypeScript type in `shared/types.ts`. Both server and client import from there. This prevents event shape mismatches.

### 3. Socket.io event naming convention
All events use `domain:action` format:

```
room:created        room:joined         room:updated
round:started       round:ended
turn:started        turn:placed         turn:flipped       turn:challenged
player:joined       player:left
error:*
```

Server emits to rooms using `io.to(roomCode).emit(...)`. Never emit to individual sockets for game events.

### 4. No database
State is a `Map<string, Room>` held in memory. Do not introduce a database, Redis, or any persistence layer. Rooms are lost on server restart — this is acceptable.

### 5. No user authentication
Players are identified by a `sessionId` (UUID generated client-side on first visit, stored in `sessionStorage`) and enter only a name. No email, no login, no JWT, no cookies. The room owner is simply the player whose `sessionId` created the room.

### 6. Spotify integration
- Use **Client Credentials Flow** only. Never use Authorization Code Flow.
- The token is fetched server-side and refreshed automatically before expiry.
- The app is in Spotify development mode (tiny request quota, many endpoints blocked). Read track data from the public embed pages where possible and keep Web API calls rare and cached — see `docs/REQUIREMENTS.md` §2.3. Test against the live API sparingly: exhausting the quota blocks the app (incl. production) for hours.
- Preview MP3s come from `track.preview_url` or, when null, the embed page; tracks without any preview resolve per turn and show "Preview unavailable".
- Never expose `SPOTIFY_CLIENT_ID` or `SPOTIFY_CLIENT_SECRET` to the client.

### 7. Audio playback sync
When a turn starts, the server emits:
```ts
{ event: 'turn:started', previewUrl: string, playAt: number, serverNow: number } // playAt = Date.now() + 600
```
Each client schedules playback `playAt - serverNow` ms after receipt (never compare server time with the device clock — clocks drift by seconds). Playback goes through the shared, gesture-unlocked element in `client/src/audio/gameAudio.ts`. Do not stream audio from the server.

---

## Game mechanics cheat sheet

| Mechanic | Rule |
|---|---|
| Starting cards | Each player/team gets 1 card face-up to anchor their timeline |
| First turn | Player/team with the oldest starting song goes first |
| Turn | Song plays → active player places card on their timeline → card flips |
| Correct | Card stays on timeline |
| Incorrect | Card discarded |
| Same year | Placing before or after a card with the same year counts as correct |
| Challenge | Non-placing participants (not spectators) can challenge during 3s window after placement. Wrong placement → challenger steals card. Correct → challenger loses a token. |
| Unrevealed song | Only active player sees blurred album art; others hear audio without title/artist/year until flip. |
| Flip reveal | Result shown ~2s (`FLIP_REVEAL_DISPLAY_MS`); server delays next turn accordingly. |
| Spectator | Joining mid-round: watch only; plays next round; cannot challenge. |
| Game log | Server-maintained `activeRound.gameLog`; client renders; survives late join. |
| Leave room | Header **Leave** emits `room:leave` (removes the player between rounds, offline mid-round) and reloads to the entry page. |
| Identity | Name only, unique per room. Joining with an offline player's name takes over that seat. |
| Token: skip | Spend 1 to discard current card, draw new one |
| Token: buy | Spend 3 to place a card directly (before hearing song). Skip next turn. |
| Token: earn | Name song title + artist correctly = +1 token (max 5) |
| Win | First to 6 correct cards on timeline |
| Deck empty | Player/team with most cards wins. Tiebreaker: highest avg release year. |
| Disconnect | Skip turn after 15s timeout. Remove from rotation after 2 missed turns. |

Game modes (Original / Pro / Expert / Cooperative) are defined in `docs/REQUIREMENTS.md` Part 1.

---

## Working approach for this project

### Before implementing any feature
1. Read the relevant section of `docs/REQUIREMENTS.md` to understand the expected behaviour.
2. Check `shared/types.ts` to see if the types you need already exist.
3. Follow the order in `CONTRIBUTING.md`: types → engine logic → test → socket event → client handler.

### When something is ambiguous
Stop and ask rather than guessing. Game logic bugs are hard to find later. A 30-second check is worth it.

### Testing multiplayer locally
Open 2–3 browser tabs at `localhost:5173`. Each tab acts as a separate player. Create a room in one tab, join it in the others.

### Commit discipline
Small, working commits. Each commit should leave the game in a playable state if possible. Use conventional commits:
```
feat: add HITSTER! challenge window
fix: correct turn order after team placement
chore: add shared types for token events
```

---

## What not to do

- Do not add a database or any persistent storage
- Do not add user accounts or login flows
- Do not stream audio from the server
- Do not put game logic in the client
- Do not use Spotify Authorization Code Flow or expose Spotify secrets to the client
- Do not add features not in REQUIREMENTS.md without confirming first
- Do not use `any` in TypeScript — define the proper type in `shared/types.ts`
