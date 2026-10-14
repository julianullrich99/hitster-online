/** Default and minimum cards on a timeline to win a round. No upper limit — the deck-empty rule ends long rounds. */
export const CARDS_TO_WIN_DEFAULT = 6;
export const CARDS_TO_WIN_MIN = 1;

/** HITSTER! challenge window after placement (ms). Server may shorten in TEST_MODE. */
export const CHALLENGE_WINDOW_MS = 3_000;

/** Max game-log lines kept per round (newest dropped). */
export const GAME_LOG_MAX_ENTRIES = 50;

/** How long the inline flip reveal (card + badge) stays visible (ms). */
export const FLIP_REVEAL_DISPLAY_MS = 2_000;

/** Selectable time (seconds) to listen and place before the turn is auto-skipped. null = no limit. Server may shorten in TEST_MODE. */
export const TURN_SECONDS_OPTIONS: readonly (number | null)[] = [30, 60, 90, 120, 180, null];
export const TURN_SECONDS_DEFAULT = 60;
