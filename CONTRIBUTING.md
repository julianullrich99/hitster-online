# Contributing to Hitster Online

---

## Before you write code

1. Read `CLAUDE.md` — project rules and constraints
2. Read `docs/ARCHITECTURE.md` — module boundaries and invariants
3. Read the relevant section of `docs/REQUIREMENTS.md` — game rules and expected behaviour
4. Check `shared/types.ts` — types you need may already exist

---

## Development setup

```bash
# Clone
git clone https://github.com/dionmeijer/hitster-online.git
cd hitster-online

# Install all dependencies
cd server && npm install
cd ../client && npm install
cd ../bots && npm install
cd ..

# Create .env for the server
cp server/.env.example server/.env
# Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET

# Run server (port 3000)
cd server && npm run dev

# Run client in a separate terminal (port 5173)
cd client && npm run dev
```

Simulate multiplayer by opening multiple tabs at `http://localhost:5173`.

---

## Running tests

```bash
# Unit tests (Jest, 125 tests)
npm test

# E2E tests (Playwright — no Spotify credentials needed)
TEST_MODE=true npx playwright test

# Bot players (manual multiplayer testing)
cd bots && npm start -- --count 10 --url http://localhost:8080
# Join specific room: add --room XXXX
```

`TEST_MODE=true` shortens all timeouts and uses mock tracks. Always use it for automated tests.

---

## How to add a feature

Follow this order — skipping steps creates type mismatches or logic/UI splits:

1. **Define the type** in `shared/types.ts` (new event payload, new state field, etc.)
2. **Write the logic** in `server/src/game/engine.ts` as a pure function
3. **Write a test** in `server/src/game/engine.test.ts` for the new function
4. **Wire the Socket.io event** in `server/src/index.ts`
   - Add the event name + payload to `ClientToServerEvents` or `ServerToClientEvents` in `shared/types.ts`
   - Register the handler in `index.ts`
   - Append to `activeRound.gameLog` via `gameLog.ts` when the event should appear in the UI log (add a `GameLogEvent` variant, render it in `client/src/game/gameLog.ts`)
5. **Handle the event client-side** in `client/src/game/useGame.ts`
6. **Build the UI** in `client/src/components/` — every visible text goes through `t()` with keys in both `client/src/i18n/de.ts` and `en.ts`

---

## Adding a new Socket.io event

**Server → Client:**
```ts
// 1. shared/types.ts — add to ServerToClientEvents
'my:event': (data: { foo: string }) => void;

// 2. server/src/index.ts — broadcast from handler
io.to(roomCode).emit('my:event', { foo: 'bar' });

// 3. client/src/game/useGame.ts — listen
socket.on('my:event', (data) => { /* update local state */ });
```

**Client → Server:**
```ts
// 1. shared/types.ts — add to ClientToServerEvents
'my:action': (data: { bar: number }) => void;

// 2. server/src/index.ts — handle
socket.on('my:action', (data) => { /* call engine, broadcast result */ });

// 3. client — emit
socket.emit('my:action', { bar: 42 });
```

Event names follow `domain:action` format: `room:*`, `round:*`, `turn:*`, `team:*`, `error`.

---

## Code style

- **No `any`** — define the proper type in `shared/types.ts`
- **No game logic in the client** — validation and state changes belong in `engine.ts`
- **Engine functions are pure** — take state, return new state, no side effects
- **Comments only when the WHY is non-obvious** — avoid restating what the code says
- TypeScript strict mode is on in all packages

---

## Commit conventions

```
feat: add HITSTER! challenge window
fix: correct turn order after team placement
chore: add shared types for token events
test: cover cooperative token depletion edge case
docs: update architecture diagram
```

Each commit should leave the server and client in a working state.

---

## Pull request checklist

- [ ] `npm test` passes (all 125 unit tests green)
- [ ] New logic has unit tests in `engine.test.ts`
- [ ] Types defined in `shared/types.ts` before logic
- [ ] No game logic added to the client
- [ ] `TEST_MODE=true npx playwright test` passes if touching game flow
- [ ] `REQUIREMENTS.md` consulted for the relevant feature rules

---

## What is out of scope

See `docs/REQUIREMENTS.md` Appendix B. Do not add databases, user accounts, native app code, non-public Spotify playlist support, or Apple Music / YouTube Music integration.
