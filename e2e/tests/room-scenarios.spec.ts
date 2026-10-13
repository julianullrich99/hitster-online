/**
 * E2E tests for the Hitster Online room lobby scenarios.
 *
 * Run with:
 *   npm run test:e2e
 *
 * Requires TEST_MODE=true server + Vite client (started automatically by
 * playwright.config.ts webServer entries).
 */

import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fillName(page: Page, name: string) {
  await page.goto('/');
  await page.waitForSelector('[data-testid="display-name-input"]');
  await page.fill('[data-testid="display-name-input"]', name);
}

async function createRoom(page: Page, topic: string): Promise<string> {
  const uniqueTopic = `${topic} ${Date.now()}`;
  await page.click('button:has-text("Create a room")');
  await page.waitForSelector('.modal-box');
  await page.fill('.modal-box input[type="text"]', uniqueTopic);
  await page.click('.modal-box button:has-text("Create")');
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible({ timeout: 8_000 });
  return uniqueTopic;
}

async function startRound(page: Page, playlistLabel?: string) {
  if (playlistLabel) {
    await page.fill('[data-testid="playlist-label-input"]', playlistLabel);
  }
  await page.click('[data-testid="start-round-btn"]');
}

async function waitForRooms(page: Page, timeout = 6_000): Promise<void> {
  // The room list polls every 2s; wait up to 6s for at least one card
  await expect(page.locator('.room-card').first()).toBeVisible({ timeout });
}

async function joinRoomByClick(page: Page, roomTopic: string): Promise<void> {
  await waitForRooms(page);
  const card = page.locator('[data-testid="room-card-joinable"].lobby', { hasText: roomTopic }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible({ timeout: 8_000 });
}

async function spectateActiveRoom(page: Page, roomTopic: string): Promise<void> {
  await waitForRooms(page);
  const card = page.locator('[data-testid="room-card-joinable"]', { hasText: roomTopic }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('.spectator-banner')).toBeVisible({ timeout: 8_000 });
}

// ---------------------------------------------------------------------------
// 1. Name persists when returning to the entry page
// ---------------------------------------------------------------------------

test('name persists after leaving a room', async ({ page }) => {
  await fillName(page, 'PersistBot');
  await createRoom(page, 'Persistence Test');

  // Verify we're in the room lobby
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible();

  // Leave the room
  await page.click('[data-testid="leave-btn"]');

  // Back at entry page — name is pre-filled from localStorage
  await expect(page.locator('[data-testid="display-name-input"]')).toHaveValue('PersistBot');
});

// ---------------------------------------------------------------------------
// 2. Start a game → room shows LIVE in lobby with current user as participant
// ---------------------------------------------------------------------------

test('active game appears in lobby with correct status and participant', async ({ browser }: { browser: Browser }) => {
  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    await fillName(p1, 'HostPlayer');
    const roomCode = await createRoom(p1, 'Active Game Room');
    await startRound(p1);

    // p1 is now in an active game — wait for game screen to appear
    await expect(p1.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

    // p2 opens the entry page — room browser should show the room as LIVE
    await p2.goto('/');
    await waitForRooms(p2);

    const card = p2.locator('.room-card', { hasText: roomCode }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('.status-badge')).toHaveText('LIVE');
    await expect(card).toContainText('HostPlayer');
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Create a room with genre "90's rock" — visible in lobby
// ---------------------------------------------------------------------------

test("room with genre '90s rock' appears in lobby with genre label", async ({ browser }: { browser: Browser }) => {
  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    await fillName(p1, 'RockBot');
    const roomCode = await createRoom(p1, '90s Rock Night');
    await startRound(p1, "90's rock");

    // p2 checks lobby
    await p2.goto('/');
    await waitForRooms(p2);

    const card = p2.locator('.room-card', { hasText: roomCode }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('.rc-genre')).toHaveText("90's rock");
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Create a room with a Spotify playlist URL — game starts (TEST_MODE uses mock tracks)
// ---------------------------------------------------------------------------

test('room with Spotify playlist URL starts successfully in TEST_MODE', async ({ browser }: { browser: Browser }) => {
  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  const spotifyUrl = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

  try {
    await fillName(p1, 'SpotifyBot');
    const roomCode = await createRoom(p1, 'Spotify Classics');
    await startRound(p1, spotifyUrl);

    // Round should start (TEST_MODE uses mock tracks regardless of URL)
    await expect(p1.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

    // Room appears in lobby with LIVE status
    await p2.goto('/');
    await waitForRooms(p2);

    const card = p2.locator('.room-card', { hasText: roomCode }).first();
    await expect(card).toBeVisible();
    await expect(card.locator('.status-badge')).toHaveText('LIVE');
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 5. All rooms from tests 3 & 4 are visible simultaneously in lobby
// ---------------------------------------------------------------------------

test('multiple rooms are all visible in the lobby at the same time', async ({ browser }: { browser: Browser }) => {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];
  const roomCodes: string[] = [];

  const rooms = [
    { name: 'Multi1', topic: 'Multi Room A', genre: 'pop' },
    { name: 'Multi2', topic: 'Multi Room B', genre: 'jazz' },
    { name: 'Multi3', topic: 'Multi Room C', genre: 'rock' },
  ];

  try {
    // Create all rooms concurrently
    for (const r of rooms) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      contexts.push(ctx);
      pages.push(page);

      await fillName(page, r.name);
      const code = await createRoom(page, r.topic);
      roomCodes.push(code);
      await startRound(page, r.genre);
    }

    // Observer page checks all rooms are visible
    const observer = await browser.newPage();
    await observer.goto('/');
    await waitForRooms(observer);

    for (let i = 0; i < roomCodes.length; i++) {
      await expect(observer.locator('.room-card', { hasText: roomCodes[i] }).first()).toBeVisible();
    }

    await observer.close();
  } finally {
    for (const ctx of contexts) await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 6a. Start round button works — transitions lobby to active game
// ---------------------------------------------------------------------------

test('start round button transitions lobby to active game', async ({ page }) => {
  await fillName(page, 'StarterBot');
  await createRoom(page, 'Start Button Test');

  // Verify we are in the lobby
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible();

  // Click Start Round
  await page.click('[data-testid="start-round-btn"]');

  // Should transition to active game within 8s
  await expect(page.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });
});

// ---------------------------------------------------------------------------
// 6b. Start round button shows loading state while connecting
// ---------------------------------------------------------------------------

test('start round button disables while starting', async ({ page }) => {
  await fillName(page, 'DisablerBot');
  await createRoom(page, 'Disable Test');

  await expect(page.locator('[data-testid="start-round-btn"]')).toBeEnabled();
  await page.click('[data-testid="start-round-btn"]');

  // After click: button is either disabled/loading OR we're already in the game
  await expect(async () => {
    const inGame = await page.locator('[data-testid="round-active"]').isVisible();
    if (inGame) return; // already transitioned — acceptable
    await expect(page.locator('[data-testid="start-round-btn"]')).toBeDisabled();
  }).toPass({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// 7. Leave room → room removed from lobby when no players remain
// ---------------------------------------------------------------------------

test('room disappears from lobby after last player leaves', async ({ browser }: { browser: Browser }) => {
  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    await fillName(p1, 'LonelyBot');
    const roomCode = await createRoom(p1, 'Lonely Room');

    // Confirm room appears in lobby
    await p2.goto('/');
    await waitForRooms(p2);
    await expect(p2.locator('.room-card', { hasText: roomCode }).first()).toBeVisible();

    // p1 leaves the room
    await p1.click('[data-testid="leave-btn"]');

    // Server has EMPTY_ROOM_TTL_MS=5s in TEST_MODE — poll lobby until room is gone
    await expect(async () => {
      await p2.reload();
      await expect(p2.locator('.room-card', { hasText: roomCode }).first()).not.toBeVisible();
    }).toPass({ timeout: 15_000, intervals: [2_000] });
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Skip and Buy buttons are visible during an active turn (items 3 & 4)
// ---------------------------------------------------------------------------

test('skip and buy buttons are visible during active turn', async ({ page }) => {
  await fillName(page, 'TurnUIBot');
  await createRoom(page, 'Turn UI Test');
  await startRound(page);

  // Wait for the active game screen
  await expect(page.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

  // Wait for a turn to start (turn:started emits turn UI)
  await expect(page.locator('[data-testid="skip-btn"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('[data-testid="buy-btn"]')).toBeVisible({ timeout: 8_000 });

  // Original mode starts with 2 tokens: skip (costs 1) enabled, buy (costs 3) disabled
  await expect(page.locator('[data-testid="skip-btn"]')).toBeEnabled();
  await expect(page.locator('[data-testid="buy-btn"]')).toBeDisabled();
});

// ---------------------------------------------------------------------------
// 9. Non-active player sees active timeline and placement (spectator view)
// ---------------------------------------------------------------------------

test('joiner sees host timeline and placement during challenge', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);

  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    await fillName(p1, 'HostWatch');
    const roomTopic = await createRoom(p1, 'Watch Timeline Test');
    await fillName(p2, 'JoinerWatch');
    await joinRoomByClick(p2, roomTopic);
    await startRound(p1);

    await expect(p1.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });
    await expect(p2.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

    // First player is random (oldest starting card) — if joiner goes first, finish their turn so host can act
    await expect(p2.locator('[data-testid="timeline-gap-0"]').or(p2.locator('[data-testid="watch-timeline"]'))).toBeVisible({
      timeout: 8_000,
    });
    if (await p2.locator('[data-testid="sidebar-turn-status"]').getByText(/your turn/i).isVisible()) {
      await p2.click('[data-testid="timeline-gap-0"]');
      await p2.click('button:has-text("CONFIRM PLACE")');
    }

    await expect(p1.locator('[data-testid="sidebar-turn-status"]')).toContainText(/your turn/i, { timeout: 20_000 });
    await expect(p2.locator('[data-testid="watch-timeline"]')).toBeVisible({ timeout: 90_000 });
    await expect(p2.locator('[data-testid="watch-timeline"]')).toContainText("HOSTWATCH'S TIMELINE");
    await expect(p2.locator('[data-testid="my-timeline-disabled"]')).toBeVisible();

    await expect(p1.locator('[data-testid="timeline-gap-0"]')).toBeVisible({ timeout: 8_000 });
    await p1.click('[data-testid="timeline-gap-0"]');
    await p1.click('button:has-text("CONFIRM PLACE")');

    await expect(p2.locator('[data-testid="watch-timeline"] .timeline-card.face-down')).toBeVisible({
      timeout: 8_000,
    });
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 9b. Mid-round joiner spectates active timeline and hears current turn
// ---------------------------------------------------------------------------

test('mid-round joiner sees active timeline and now playing', async ({ browser }: { browser: Browser }) => {
  test.setTimeout(120_000);

  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    await fillName(p1, 'HostSpec');
    const roomTopic = await createRoom(p1, 'Mid Spectate Test');
    await startRound(p1);

    await expect(p1.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

    await fillName(p2, 'LateSpec');
    await spectateActiveRoom(p2, roomTopic);

    await expect(p2.locator('[data-testid="watch-timeline"]')).toBeVisible({ timeout: 15_000 });
    await expect(p2.locator('[data-testid="watch-timeline"]')).toContainText("HOSTSPEC'S TIMELINE");
    await expect(p2.locator('[data-testid="now-playing-status"]')).toBeVisible({ timeout: 15_000 });
    await expect(p2.locator('.now-playing .song-title')).toHaveCount(0);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Name song panel visible and submittable during active turn (item 3)
// ---------------------------------------------------------------------------

test('name song panel is visible and inputs work during active turn', async ({ page }) => {
  await fillName(page, 'NameSongBot');
  await createRoom(page, 'Name Song Test');
  await startRound(page);

  await expect(page.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

  // Wait for name song inputs
  await expect(page.locator('[data-testid="name-song-title"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('[data-testid="name-song-artist"]')).toBeVisible({ timeout: 8_000 });

  // Submit button is disabled when inputs are empty
  await expect(page.locator('[data-testid="name-song-submit"]')).toBeDisabled();

  // Filling both inputs enables the submit button
  await page.fill('[data-testid="name-song-title"]', 'Some Title');
  await page.fill('[data-testid="name-song-artist"]', 'Some Artist');
  await expect(page.locator('[data-testid="name-song-submit"]')).toBeEnabled();
});

// ---------------------------------------------------------------------------
// 11. Disconnected player's turn auto-advances after TURN_TIMEOUT (item 6)
// ---------------------------------------------------------------------------

test('disconnected player turn auto-advances after timeout', async ({ browser }: { browser: Browser }) => {
  const ctx1: BrowserContext = await browser.newContext();
  const ctx2: BrowserContext = await browser.newContext();
  const p1: Page = await ctx1.newPage();
  const p2: Page = await ctx2.newPage();

  try {
    // p1 creates room and starts round
    await fillName(p1, 'HostBot');
    const roomCode = await createRoom(p1, 'Disconnect Test');

    // p2 joins by double-clicking the room in the lobby list
    await fillName(p2, 'JoinerBot');
    await joinRoomByClick(p2, roomCode);

    await startRound(p1);

    // Both players should see the active game
    await expect(p1.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });
    await expect(p2.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 8_000 });

    // Record which player has the first turn and disconnect them
    // p2 sees "You" when p2 is active, "HostBot" when p1 is active
    const firstActivePlayerEl = p2.locator('.active-player .player-name');
    const firstActiveName = await firstActivePlayerEl.textContent({ timeout: 5_000 });

    // Disconnect the active player; observe from the other
    let observerPage: Page;
    if (firstActiveName?.includes('HostBot')) {
      await ctx1.close(); // p1 (HostBot) is active — disconnect p1, observe from p2
      observerPage = p2;
    } else {
      await ctx2.close(); // p2 (JoinerBot/You) is active — disconnect p2, observe from p1
      observerPage = p1;
    }

    // TURN_TIMEOUT_MS = 3s in TEST_MODE — after it fires the remaining player becomes active
    // Allow up to 10s for the auto-skip + turn advance to propagate
    await expect(async () => {
      const activeNow = await observerPage.locator('.active-player').isVisible().catch(() => false);
      expect(activeNow).toBe(true);
    }).toPass({ timeout: 10_000, intervals: [1_000] });
  } finally {
    await ctx1.close().catch(() => {});
    await ctx2.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 12. Mode selector UI — all options visible and selectable (item 1)
// ---------------------------------------------------------------------------

test('mode selector shows all modes and can be changed', async ({ page }) => {
  await fillName(page, 'ModeHost');
  await createRoom(page, 'Mode Test');
  await expect(page.locator('[data-testid="lobby-screen"]')).toBeVisible({ timeout: 8_000 });

  // Mode selector should be visible to the room owner
  await expect(page.locator('[data-testid="mode-selector"]')).toBeVisible();

  // All four modes should be present
  await expect(page.locator('[data-testid="mode-option-original"]')).toBeVisible();
  await expect(page.locator('[data-testid="mode-option-pro"]')).toBeVisible();
  await expect(page.locator('[data-testid="mode-option-expert"]')).toBeVisible();
  await expect(page.locator('[data-testid="mode-option-cooperative"]')).toBeVisible();

  // Selecting a different mode works
  await page.click('[data-testid="mode-option-pro"]');
  await expect(page.locator('[data-testid="mode-option-pro"]')).toHaveClass(/selected/);

  // Cards-to-win and tokens-enabled are visible
  await expect(page.locator('[data-testid="cards-to-win-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="tokens-enabled-toggle"]')).toBeVisible();
});

// ---------------------------------------------------------------------------
// Name identity: same name in the same room takes over the offline seat
// ---------------------------------------------------------------------------

test('rejoining with the same name restores the player', async ({ browser }: { browser: Browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const ctx3 = await browser.newContext();
  try {
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    await fillName(p1, 'HostName');
    const topic = await createRoom(p1, 'Name Rejoin');

    await fillName(p2, 'Rejoiner');
    await joinRoomByClick(p2, topic);
    await expect(p1.locator('[data-testid="lobby-player-name"]', { hasText: 'Rejoiner' })).toBeVisible();

    // Same name while the original is online → rejected
    const p3 = await ctx3.newPage();
    await fillName(p3, 'rejoiner');
    await waitForRooms(p3);
    await p3.locator('[data-testid="room-card-joinable"]', { hasText: topic }).first().click();
    await expect(p3.locator('.server-error-msg')).toContainText('already taken');

    // Original drops (tab closed) → same name takes the seat over, no duplicate player
    await ctx2.close();
    await expect(p1.locator('.lobby-player-chip', { hasText: 'Rejoiner' }).locator('.player-disconnected-badge')).toBeVisible({ timeout: 8_000 });
    await p3.locator('[data-testid="room-card-joinable"]', { hasText: topic }).first().click();
    await expect(p3.locator('[data-testid="lobby-screen"]')).toBeVisible({ timeout: 8_000 });
    await expect(p1.locator('[data-testid="lobby-player-name"]', { hasText: /rejoiner/i })).toHaveCount(1);
    await expect(p1.locator('.lobby-player-chip', { hasText: 'Rejoiner' }).locator('.player-disconnected-badge')).toHaveCount(0);
  } finally {
    await ctx1.close();
    await ctx3.close();
  }
});

// ---------------------------------------------------------------------------
// Hot-seat: two players on one device
// ---------------------------------------------------------------------------

test('hot-seat: local players join, take turns and can challenge on one screen', async ({ page }) => {
  await fillName(page, 'Couch1');
  await createRoom(page, 'Hot Seat');

  await page.fill('[data-testid="local-player-name-input"]', 'Couch2');
  await page.click('[data-testid="add-local-player-btn"]');
  await expect(page.locator('[data-testid="local-player-row"]', { hasText: 'Couch2' })).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('[data-testid="lobby-player"]')).toHaveCount(2);

  await startRound(page);
  await expect(page.locator('[data-testid="round-active"]')).toBeVisible({ timeout: 15_000 });

  // Whoever is on turn, this screen can place for them
  await expect(page.locator('[data-testid="hotseat-banner"]')).toBeVisible({ timeout: 10_000 });
  const firstPlayer = (await page.locator('[data-testid="hotseat-banner"]').innerText()).includes('Couch1') ? 'Couch1' : 'Couch2';
  const otherPlayer = firstPlayer === 'Couch1' ? 'Couch2' : 'Couch1';
  await page.click('[data-testid="timeline-gap-0"]');
  await page.click('button:has-text("CONFIRM PLACE")');

  // The other local player gets a challenge button for this placement
  const challenge = page.locator('[data-testid="challenge-btn"]', { hasText: otherPlayer });
  await expect(challenge).toBeVisible({ timeout: 5_000 });
  await challenge.click();
  await expect(page.locator('[data-testid="challenge-btn"]', { hasText: `${otherPlayer} ✓` })).toBeVisible();

  // Next turn passes to the other local player on the same screen
  await expect(page.locator('[data-testid="hotseat-banner"]')).toContainText(otherPlayer, { timeout: 15_000 });
});
