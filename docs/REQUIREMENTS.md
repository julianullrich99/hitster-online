# Hitster Online — Requirements

> Status: v0.6 — updated to match current implementation
> Last updated: 2026-05-20

---

## Part 1 — Functional Requirements

_What the system does from a player's perspective. No technical detail._

---

### 1.1 Player Onboarding
- A player opens the game URL and enters only their **name** (required, max 24 chars). No email, no account.
- The name is shown to other players and **identifies the player within a room**: names are unique per room (trimmed, case-insensitive).
  - Joining with a name that belongs to an **online** player is rejected ("name already taken").
  - Joining with the name of an **offline** player takes over that seat — timeline, tokens, team and ownership — e.g. after closing the tab, a phone reload or switching devices.
- The last used name is remembered on the device (`localStorage`) and pre-filled.
- After completing the form, the player can either:
  - **Create a room** (becoming the room owner), or
  - **Join a room** by entering a 4-character room code, or
  - **Click directly into an existing room** shown in the room browser (see §1.1.1).
- If the page is loaded with a `?room=XXXX` query parameter (e.g. from a shared invite link), the join form should be pre-filled with that code automatically. _(not yet implemented)_

#### 1.1.1 Room Browser
- The entry page displays a live list of all **active rooms** on the server (lobby or in-progress).
- Each room card shows:
  - **Room code** and **topic / description** set by the owner
  - **Genre / playlist** (e.g. "90s Night", "Pop Classics") — the song source label
  - **Participants**: player count and leader name
  - **Round status**: lobby waiting, or current round number
  - **Progress**: for in-progress rounds, the leading player/team's card count and the target (e.g. "Mike — 4 / 6 cards")
- Clicking a room card joins it directly (a name must be entered first). A room code can also be typed in.
- Rooms in **LOBBY** state can be joined freely.
- Rooms in **ROUND_ACTIVE** state can be joined as a **spectator**: watch the active timeline and game log, but no placement, tokens, or challenges until the next round.
- Rooms in **GAME_OVER** state are shown greyed-out and cannot be joined.
- The room list auto-refreshes every **2 seconds**.

### 1.2 Rooms
- Each room has a unique **room code** and a shareable **invite link** (copies `?room=XXXX` URL to clipboard from the lobby).
- The owner sets a **topic / description** for the room (e.g. "90s Night", "Office Party").
- Multiple game rounds can be played within the same room without players having to rejoin.
- Players can join a room at any point while it is in the **lobby** state (before a round starts).
- Only the room owner can configure rounds and start the game.
- Maximum **12 players** or **6 teams** per room.
- **Leave** removes the player from the room between rounds (ownership passes to the next connected player); mid-round they stay on the board as offline so they can rejoin by name.
- When **every participant is offline** (no open Socket.io connection), the room is removed from the server after a short grace period (~60s; 5s in test mode), including mid-round and game-over rooms.

### 1.3 Teams
- Any player in the lobby can create a team and invite others to join.
- Teams share a single timeline and token pool during a round.
- If no teams are created, each player has their own individual timeline.
- Players can join/leave teams between rounds. Teams carry over unless changed.
- A round in team mode requires at least 2 teams, each with at least 1 player.

### 1.3.1 Local Versus (Hot-Seat)
- Several players can play on **one device** (TV, laptop, shared PC). In the lobby, any player can add more players "on this device" by name and remove them again.
- Every local player is a normal room participant (own timeline, tokens, turns); online players can join the same room as usual.
- The screen follows the turn: when a local player is on turn, the device shows their timeline, tokens and actions, with a "<name>'s turn" banner.
- During the challenge window, each local player who is not placing gets their own **challenge** button.
- Hidden information (blurred album art for the active player) is not meaningful on a shared screen and is accepted as such.

### 1.3.2 Devices & Layout
- The UI is responsive: desktop/TV (three columns, larger cards on ≥1600px), tablet and phone (single scrolling column, scoreboard strip, sticky action bar).
- On phones (≤640px) the timeline is vertical — oldest at the top, gaps as full-width bars.
- Cards can be placed by drag & drop or by **tapping a gap** and confirming.

### 1.4 Round Configuration
Before each round, the room owner sets:

| Setting | Options | Default |
|---|---|---|
| Song source | Spotify playlist URL or genre/theme | — |
| Game mode | Original / Pro / Expert / Cooperative | Original |
| Tokens enabled | Yes / No | Yes |
| Cards needed to win | 1 or more (no upper limit; an empty deck ends the round) | 6 |
| Time per turn | 30 / 60 / 90 / 120 / 180 s, or no limit — auto-skip if the active player hasn't placed | 60 s |

### 1.5 Gameplay — Hitster Rules (Digital)

#### Setup
- Each player/team receives **1 starting card** face-up (showing title, artist, and release year). This is the anchor of their timeline.
- The player/team with the **oldest starting song** takes the first turn.
- Starting token counts depend on game mode (see Game Modes table below).

#### Turn Structure
Each turn has three phases:

**REVEAL** — A new card is drawn from the deck and the song starts playing for all players simultaneously (synchronised via a server-issued `playAt` timestamp). No player sees the song's title, artist, or year until the card is flipped after placement; only the active player sees blurred album art while placing.

**PLACE** — The placing player selects a position on their timeline. The card is placed face-down. A **3-second challenge window** then opens for non-placing participants (not spectators).

**FLIP** — The card is revealed with a short animation; the correct/wrong result stays visible for **2 seconds** before the next turn starts. Placement is correct if the release year fits chronologically between its neighbours (same year as a neighbour also counts as correct). If correct, the card stays on the timeline. If incorrect, the card is discarded.

#### Token Mechanics

| Action | Rule |
|---|---|
| **Skip card** (your turn) | Spend 1 token to discard the current card and draw a new one. |
| **Challenge** | During the challenge window, any non-placing **participant** (not a spectator) can challenge via the **Challenge** button under the placed card. If the opponent placed incorrectly, challenger steals the card. If the opponent was correct, the challenger loses a token. |
| **Buy a card** | Spend 3 tokens to place a card on your timeline without hearing the song. Your next turn is auto-skipped. |
| **Earn a token** | Name the song title AND artist correctly during your turn = +1 token (max 5). Original/Cooperative only. |

#### Game Modes

| Mode | Rule | Starting Tokens |
|---|---|---|
| **Original** | Standard rules. Naming song earns +1 token. | 2 |
| **Pro** | Placing player must correctly name title + artist during the challenge window for the card to count. No naming token bonus. | 5 |
| **Expert** | Placing player must correctly name title, artist, and exact release year for the card to count. No naming token bonus. | 3 |
| **Cooperative** | All players share one timeline and one token pool. Incorrect placement costs 1 shared token. Win by reaching the card target; lose if tokens hit 0. No challenges. | 5 (shared) |

#### Winning
- **Individual / team**: First to correctly place the target number of cards on their timeline wins the round.
- **Cooperative**: Reach the card target before the shared token pool runs out.
- **Deck empty**: Player/team with the most cards wins. Tiebreaker: highest average release year.

### 1.6 Multiple Rounds
- After a round ends, the room returns to **lobby** state. The owner can start a new round with new or identical settings.
- Round history (winner, mode, round number) is shown on the end-of-round screen.
- Teams and player assignments carry over unless changed before the next round.

### 1.7 Known Limitations (v1)
- Spotify playlist URLs must be **public** playlists.
- Tracks with no 30-second audio preview (`preview_url = null`) are excluded from the deck automatically. The count is logged server-side; a future version may surface this in the lobby UI.
- If the deck runs out of cards before anyone wins, the tiebreaker rule (most cards, then highest avg year) applies.

---

## Part 2 — Technical Requirements

---

### 2.1 Real-Time Multiplayer
- All players in a room see game state changes in real time via Socket.io.
- Latency for game state updates should be imperceptible during normal play (<200ms).

### 2.2 Audio Synchronisation
- The server sends `previewUrl` + `playAt` (server Unix ms, ~600ms in the future) + `serverNow` to all clients simultaneously.
- Each client converts to its own clock (`Date.now() + (playAt - serverNow)`) — device clocks are often off by seconds — and schedules `play()` via `setTimeout`.
- Playback uses one shared audio element that is unlocked by the first user gesture (required by iOS Safari and other autoplay policies). If the browser still blocks playback, the player sees a **Tap to play** button; a late start seeks to the synced position.
- Acceptable sync variance: ≤500ms between clients.

### 2.3 Spotify Integration
- Server authenticates with Spotify via **Client Credentials Flow** (no user login).
- The app runs in Spotify **development mode**: no `/recommendations`, no playlist contents via the API, no batch endpoints, search `limit` ≤ 10, no popularity/genres, and a small request quota (exceeding it blocks the app for hours).
- Deck sources (all return title, artist(s), release year, album art and — via the embed page — the 30s preview MP3):
  - **Decade** label (`80s`, `80er`, `1990s`, `1975-1985`, `1985`): Spotify's editorial "All Out 50s…2010s" playlists, read from the public embed pages — no API quota. API `year:` search fills gaps (e.g. 2020s).
  - **No label**: hits spread evenly across the 1960s–2020s, same sources.
  - **Genre/topic** (`Schlager`, `90s Hip Hop`): API playlist search (cached 24h), best-matching curated playlist read via embed; a decade in the label filters the tracks.
  - **Playlist URL**: read via its embed page (max. 100 tracks).
  - The `genre:` search filter is not used — it returns mostly obscure tracks.
- Release years must be the song's year: tracks outside a requested decade are dropped; without a decade, remasters/compilations get their earliest release year via search (capped per deck) or are dropped. Version suffixes (" - 2013 Remaster", "(Original Single Mix)") are removed from titles.
- API responses and embed data are cached in memory. On a quota 429 the server stops calling the API until Retry-After; on embed 429 it uses cached data only for 10 minutes.

### 2.4 Audio Playback
- The `preview_url` is a publicly accessible 30-second MP3 on Spotify's CDN.
- Client plays it directly in a `<audio>` element. No server-side audio streaming.

### 2.5 Game State
- All game state is server-side and broadcast via WebSocket. Clients are stateless renderers.

### 2.6 No Authentication
- Players are identified by session ID (UUID in `sessionStorage`) and, within a room, by their unique name (see §1.1).
- Room ownership is tied to the creator's session ID (taken over along with the seat when rejoining by name).

---

## Part 3 — Design & Architecture

### 3.1 Components

```
┌─────────────────────────────────────────┐
│               Browser (client)          │
│  - React 18 + TypeScript + Vite         │
│  - Socket.io client                     │
│  - <audio> element for preview playback │
└────────────────┬────────────────────────┘
                 │ WebSocket
┌────────────────▼────────────────────────┐
│               Server (Node.js)          │
│  - Express + Socket.io v4               │
│  - Game state engine (pure functions)   │
│  - Room / session management            │
│  - Spotify API client                   │
└────────────────┬────────────────────────┘
                 │ HTTPS (Client Credentials)
┌────────────────▼────────────────────────┐
│            Spotify Web API              │
└─────────────────────────────────────────┘
```

### 3.2 Data Flow — Turn Lifecycle

1. Server draws next card, resolves `previewUrl` / `streamUrl`
2. Server emits `turn:started` → `{ activePlayerId, card: CardHidden, previewUrl, playAt, timelineLength, turnEndsAt }`
3. Active player: audio plays, timeline interactive, song identity hidden (blurred album art only)
4. Other participants: audio only until flip; **Challenge** under placed card during challenge window (watch timeline UI)
5. Spectators: watch active timeline + server game log; cannot challenge
6. Active player confirms position → `turn:placed` → challenge window (`CHALLENGE_WINDOW_MS`, 3s)
7. Timer expires → `turn:flipped` → inline reveal (~2s) → server waits `FLIP_REVEAL_DISPLAY_MS` → next turn
8. In Pro/Expert: card only lands on timeline if placing player named correctly (`currentTurn.named === true`)
9. Win check → `round:ended` or advance to next turn

### 3.3 Room State Machine

```
LOBBY → ROUND_ACTIVE → ROUND_ENDED → LOBBY (next round)
              │
              └── room:end (owner) → GAME_OVER
```

### 3.4 Resolved Design Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Turn structure | Each player places on their own timeline on their turn. |
| 2 | Team placement | Any team member can place; first click confirms. |
| 3 | Challenge window | 3 seconds after placement (`CHALLENGE_WINDOW_MS`). |
| 8 | Unrevealed track privacy | Only the active player sees blurred album art; others hear audio without title/artist/year until flip. |
| 9 | Flip reveal pacing | Client shows result for 2s (`FLIP_REVEAL_DISPLAY_MS`); server delays next turn by the same interval. |
| 10 | Spectators | Mid-round joiners are spectators until the next round; no challenge UI. |
| 11 | Server game log | `activeRound.gameLog` appended on server; clients render for all (including late joiners). |
| 12 | Empty room cleanup | Delete room when all participants offline (~60s grace; 5s in test mode). |
| 4 | Deck exhaustion | Most cards wins; tiebreaker = highest avg release year. |
| 5 | Player disconnection | 15s auto-skip; removed from turn order after 2 consecutive missed turns. Disconnected players show an offline badge. |
| 6 | Room size | Max 12 players or 6 teams. |
| 7 | Poll interval | Room browser refreshes every 2s. |

---

## Part 4 — Technology Stack

### 4.1 Stack Overview

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS |
| Drag & drop | @dnd-kit/core |
| Real-time | Socket.io v4 |
| Backend | Node.js + TypeScript, Express |
| External API | Spotify Web API (Client Credentials Flow) |
| State | In-memory only — no database |
| Hosting | Fly.io (primary); Railway optional |

### 4.2 Repo Structure

```
/
├── server/src/
│   ├── index.ts          # Express + Socket.io entry point
│   ├── game/             # Pure game logic (engine.ts + tests)
│   ├── rooms/            # RoomStore
│   └── spotify/          # SpotifyClient + mock tracks
├── client/src/
│   ├── components/       # GameRoom, EntryPage
│   ├── game/             # useGame hook
│   └── socket/           # Socket.io client
├── shared/types.ts        # All shared TypeScript types
├── bots/                  # Bot harness (profiles.yaml, bot.ts, index.ts)
├── e2e/                   # Playwright E2E tests
└── .github/workflows/ci.yml
```

### 4.3 CI Pipeline

| Job | Steps |
|---|---|
| **server** | `npm ci` (root) → TypeScript build → Jest (125 tests) |
| **client** | `npm ci` (root) → Vite build |
| **e2e** | Depends on server+client → Playwright with TEST_MODE server |

---

## Part 5 — Deployment

### 5.1 Platform
**Fly.io** — one always-on Machine (in-memory state), WebSockets, Docker deploy. See `docs/DEPLOY_FLY.md`. Railway (`railway.toml`) remains supported as an alternative.

### 5.2 Environment Variables

| Variable | Description |
|---|---|
| `SPOTIFY_CLIENT_ID` | Spotify app client ID |
| `SPOTIFY_CLIENT_SECRET` | Spotify app client secret |
| `PORT` | Server port (default: 3000) |
| `CLIENT_URL` | Allowed CORS origin (default: `http://localhost:5173`) |

### 5.3 TEST_MODE
`TEST_MODE=true` shortens timeouts (challenge window 500ms, flip reveal 300ms, empty-room TTL 5s, disconnect skip 3s) and enables mock Spotify tracks so tests run without real credentials.

---

## Part 6 — Testing

### 6.1 Unit Tests
Jest, 125 tests in `engine.test.ts`, `store.test.ts`, `client.test.ts`.
Run: `npm test` from root or `server/`.

Coverage: placement validation, token accounting (all modes), challenge resolution, win/loss detection, cooperative token depletion, Pro/Expert naming enforcement, max room size, disconnect handling, deck exhaustion tiebreak.

### 6.2 E2E Tests
Playwright, `e2e/tests/room-scenarios.spec.ts`. Runs against a live TEST_MODE server.
Run: `npx playwright test` from root.

### 6.3 Bot Players
`/bots/` — profile-driven Socket.io clients. Used for demo and manual testing.
Run: `npm start` from `bots/` or `npm run test:bots` from root.
CLI flags: `--room XXXX`, `--count N`, `--mode <mode>`, `--genre <label>`.

---

## Appendix A — Not Yet Implemented

| # | Feature | Section |
|---|---|---|
| 1 | `?room=XXXX` URL param auto-fills join code on page load | §1.1 |
| 2 | Null-preview track count shown in lobby UI (server logs it only) | §1.7 |

---

## Appendix B — Out of Scope (v1)

- User accounts or persistent profiles
- Leaderboards across sessions
- Native mobile app
- Private Spotify playlist support
- Apple Music or YouTube Music support
- Persistent room history across server restarts
