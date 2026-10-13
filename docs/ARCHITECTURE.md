# Architecture — Hitster Online

> Read this before writing code. It describes module contracts, data flow, and the invariants every agent must preserve.

---

## High-level overview

```
Browser (React)
  └─ socket/client.ts ──WebSocket──► server/src/index.ts
                                          ├─ game/engine.ts   (pure logic)
                                          ├─ rooms/store.ts   (in-memory state)
                                          └─ spotify/client.ts (external API)
```

The server owns **all game state**. Clients are stateless renderers that reflect whatever the server broadcasts. There is no REST API for game actions — everything flows through Socket.io events.

---

## Module responsibilities

### `shared/types.ts`
Single source of truth for every TypeScript type used by both server and client. **Always define types here first** before writing logic. Both sides import from this file directly.

Key types:
- `Room` — top-level container (players, teams, round config, active round)
- `ActiveRound` — everything needed to run a round in progress
- `CurrentTurn` — the narrow state of the current turn (phase, placement, challenges)
- `ServerToClientEvents` / `ClientToServerEvents` — typed Socket.io contracts

### `server/src/game/engine.ts`
Pure functions — no I/O, no side effects, no imports from outside `shared/`. Every function takes state and returns new state. This is the only place where game rules are enforced.

Key functions:
| Function | Purpose |
|---|---|
| `createRoom` | Build a fresh Room value |
| `addPlayer` / `markReconnected` / `markDisconnected` | Player lifecycle |
| `initRound` | Deal starting cards, build turn order, set tokens |
| `drawCard` | Pop from deck, return hidden card for broadcast |
| `applyPlacement` | Validate position, record placement in CurrentTurn |
| `resolveFlip` | Evaluate correctness, apply challenges, update timeline/tokens |
| `advanceTurn` | Move turnIndex forward, wrap around |
| `applySkip` / `applyBuy` / `applyNamingBonus` | Token mechanics |
| `isActiveParticipant` | Check if a sessionId can act on the current turn |
| `activeEntityId` | Map a playerId to its teamId if using teams |
| `buildRoundSummary` / `checkWin` | End-of-round resolution |
| `allParticipantsOffline` | True when every player has `isConnected === false` |
| `endGame` | Set `room.status` to `game_over` (owner action) |

**Do not add I/O, timers, or Socket.io references here.**

### `server/src/game/gameLog.ts`
Appends structured lines to `activeRound.gameLog` (placements, challenges, flips, skips). Used for the in-round log panel and late joiners.

### `server/src/rooms/store.ts`
Thin wrapper around `Map<string, Room>`. Provides `get`, `set`, `delete`, `getAll`, `getSummaries`. No logic beyond storage and projection to `RoomSummary`.

### `server/src/spotify/client.ts`
Handles Spotify Client Credentials auth (auto-refreshes token before expiry) and deck building. Returns typed `Card[]`. Because the app is in Spotify development mode, track data mostly comes from the public embed pages (`embedPreview.ts`) and the Web API is only used sparingly (playlist search, year search, original-year lookups) behind a TTL cache and a quota circuit breaker — see REQUIREMENTS §2.3. Label parsing and title cleanup live in `labels.ts` (pure). `TEST_MODE=true` substitutes mock tracks from `mockTracks.ts` so tests run without credentials.

### `server/src/index.ts`
The orchestration layer. Owns all timers, the Socket.io server, and the live-data Maps that cannot live in `Room` (decks, pending cards, challenge lists). Translates Socket.io events into calls to `engine.*` and broadcasts results.

Server-side Maps (keyed by `roomCode`):
```
socketSession  — socketId → { sessionId, roomCode }
liveDecks      — remaining deck (Card[]) for each active room
pendingCards   — card drawn this turn, not yet resolved
pendingChallenges — challenges collected during challenge window
challengeTimers   — setTimeout handle for each challenge window
flipAdvanceTimers — delay `advanceTurn` until flip reveal UI completes (`FLIP_REVEAL_DISPLAY_MS`)
pendingDeletes    — delete room after EMPTY_ROOM_TTL when every player is offline (any room status)
disconnectTimers  — per-player auto-skip timers
```

### `client/src/socket/client.ts`
Creates the typed `io()` connection, attaches `sessionId`, `displayName`, and `email` as Socket.io `auth`. Re-exports the socket instance for use across the app.

### `client/src/game/useGame.ts`
React hook. Manages local UI state and maps Socket.io events to state updates. The only component allowed to call `socket.emit(...)`. All child components receive props or context — they never touch the socket directly.

### `client/src/components/`
Presentational components. Receive state and callbacks as props. No game logic.

---

## Turn lifecycle — end to end

```
1. server startTurn()
   ├─ engine.drawCard(deck)  →  { card: Card, hidden: CardHidden, remaining }
   ├─ liveDecks.set(roomCode, remaining)
   ├─ pendingCards.set(roomCode, card)
   └─ io.emit('turn:started', { card: CardHidden, previewUrl, playAt, serverNow, activePlayerId, ... })

2. client receives 'turn:started'
   ├─ Active player: blurred album art only; title/artist/year hidden until flip
   └─ Other players (and spectators): hear audio; no unrevealed track metadata

3. Placing player emits 'turn:place' { position }
   ├─ server engine.applyPlacement() → sets currentTurn.phase = 'challenge'
   ├─ gameLog.logPlacement()
   ├─ io.emit('turn:placed', { position, activePlayerId, challengeEndsAt })
   └─ challengeTimers.set(roomCode, setTimeout(resolveAndAdvance, CHALLENGE_WINDOW_MS))

4. Non-placing participants (not spectators) may emit 'turn:challenge'
   └─ pendingChallenges.push({ challengerId }); gameLog.logChallenge()
      io.emit('turn:challenged', { challengerId })

5. Challenge window expires → resolveAndAdvance()
   ├─ inject pendingChallenges into room.activeRound.currentTurn
   ├─ engine.resolveFlip()  →  { room, correct, winnerId }
   ├─ gameLog.logFlipResolution()
   ├─ io.emit('turn:flipped', { card, correct, timelines, tokensUpdated, ... })
   ├─ if winnerId → io.emit('round:ended', ...) and stop
   └─ else → after FLIP_REVEAL_DISPLAY_MS → engine.advanceTurn() → startTurn()

Mid-round join / reconnect: emitTurnSnapshot() sends a private turn:started to catch up UI.
```

---

## Room state machine

```
LOBBY ──round:start──► ROUND_ACTIVE ──win / deck empty──► ROUND_ENDED ──owner restart──► LOBBY
                              │
                              └── room:end (owner) ──► GAME_OVER
```

When every participant disconnects, the room is deleted after `EMPTY_ROOM_TTL_MS` (any status).

---

## Audio synchronisation

The server sets `playAt = Date.now() + 600`. Every client calls:

```ts
const delay = playAt - Date.now();
setTimeout(() => audioElement.play(), Math.max(0, delay));
```

No audio is streamed through the server. The `previewUrl` is a public Spotify CDN URL played directly by the browser.

---

## Team mode

When `room.useTeams = true`, timelines and token pools are keyed by `teamId`, not `playerId`. The turn order contains `teamId`s. `engine.activeEntityId(room, playerId)` resolves the correct entity ID regardless of mode — always use this helper instead of checking `useTeams` manually.

---

## Player identity

Players are identified by `sessionId` — a UUID generated client-side on first visit and stored in `sessionStorage`. On reconnect, the same `sessionId` allows the server to restore the player's state. Email is stored in `Player` but is never broadcast to other clients.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | — | Required for real track fetching |
| `SPOTIFY_CLIENT_SECRET` | — | Required for real track fetching |
| `PORT` | `3000` | HTTP + WebSocket port |
| `CLIENT_URL` | `http://localhost:5173` | CORS allowed origin, redirect target in dev |
| `TEST_MODE` | `false` | Shortens timeouts (challenge 500ms, flip reveal 300ms, empty-room TTL 5s), uses mock tracks |

---

## Key invariants

1. **All game logic lives in `engine.ts`.** `index.ts` may not contain placement rules, win checks, or token arithmetic.
2. **`shared/types.ts` is the schema.** Never use `any`. Define the type first, then write the code.
3. **State is immutable at the function level.** Engine functions return new objects; they do not mutate arguments.
4. **Timers live only in `index.ts`.** Engine functions are synchronous and timer-free.
5. **No database.** `RoomStore` is an in-memory Map. Server restart clears all state. This is intentional.
6. **No Spotify secrets on the client.** The client never calls Spotify directly.

---

## Where to put new things

| What | Where |
|---|---|
| New game rule or validation | `engine.ts` |
| New shared type or event shape | `shared/types.ts` |
| New Socket.io event handler | `index.ts` (handler) + `engine.ts` (logic) |
| New React UI state | `useGame.ts` hook |
| New UI component | `client/src/components/` |
| New Spotify query | `spotify/client.ts` |
| New test for game logic | `engine.test.ts` |
| New test for room storage | `store.test.ts` |
| New E2E scenario | `e2e/tests/room-scenarios.spec.ts` |

---

## Testing

### Unit tests (Jest)
Located in the same directory as the module they test (e.g., `engine.test.ts` next to `engine.ts`). Run from root:

```bash
npm test
```

125 tests cover: placement validation, all token mechanics, challenge resolution, win/loss detection, cooperative depletion, Pro/Expert naming enforcement, max room size, disconnect handling, deck exhaustion tiebreak.

### E2E tests (Playwright)
`e2e/tests/room-scenarios.spec.ts` — runs against a live `TEST_MODE=true` server. Run from root:

```bash
npx playwright test
```

### Bot players
Simulated Socket.io clients in `/bots/`. Useful for manual multiplayer testing:

```bash
cd bots && npm start -- --count 10 --url http://localhost:8080
# Or join a specific room: --room XXXX
```

Profiles in `bots/profiles.yaml` control decision timing and strategy.
