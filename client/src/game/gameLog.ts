import { isGameLogFlipLine, type GameLogEntry, type GameLogLine } from '../../../shared/types';
import type { TFunction } from '../i18n';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface RenderedLogEntry {
  id: string;
  html: string;
}

/** Who / action / consequence of a server event, in the current language (already escaped). */
function describe(entry: GameLogLine, t: TFunction): { who: string; action: string; result: string } | null {
  const esc = escapeHtml;
  const coins = (n: number) => t('common.coins', { count: n });
  switch (entry.event) {
    case 'round_started':
      return {
        who: esc(t('log.who.game')),
        action: esc(t('log.round_started.action')),
        result: esc(t('log.round_started.result', { round: entry.round })),
      };
    case 'placed':
      return {
        who: esc(entry.who),
        action: esc(t('log.placed.action')),
        result: esc(t('log.placed.result', { seconds: entry.seconds })),
      };
    case 'challenged':
      return { who: esc(entry.who), action: esc(t('log.challenged.action')), result: esc(t('log.challenged.result')) };
    case 'revealed':
      return {
        who: esc(entry.who),
        action: esc(t('log.revealed.action')),
        result: esc(t(entry.correct ? 'log.revealed.correct' : 'log.revealed.wrong', { who: entry.who })),
      };
    case 'challenge_won':
    case 'challenge_lost':
      return {
        who: esc(entry.who),
        action: esc(t('log.challenge.action')),
        result: esc(t(entry.event === 'challenge_won' ? 'log.challenge_won.result' : 'log.challenge_lost.result', {
          who: entry.who,
          placer: entry.placer,
        })),
      };
    case 'skipped':
      return {
        who: esc(entry.who),
        action: esc(t('log.skipped.action')),
        result: esc(t('log.skipped.result', { coins: coins(entry.coins) })),
      };
    case 'bought':
      return {
        who: esc(entry.who),
        action: esc(t('log.bought.action')),
        result: esc(t('log.bought.result', { coins: coins(entry.coins) })),
      };
    case 'named':
      return {
        who: esc(entry.who),
        action: esc(t(entry.result === 'gained' ? 'log.named.actionGained' : 'log.named.action')),
        result: esc(
          entry.result === 'counts'
            ? t('log.named.counts')
            : t(entry.result === 'gained' ? 'log.named.gained' : 'log.named.max', { coins: coins(entry.coins) }),
        ),
      };
    case 'turn_skipped':
      return {
        who: esc(entry.who),
        action: esc(t('log.turn_skipped.action')),
        result: esc(t(entry.reason === 'timeout' ? 'log.turn_skipped.timeout' : 'log.turn_skipped.disconnect')),
      };
    case 'kicked':
      return { who: esc(entry.who), action: esc(t('log.kicked.action')), result: esc(t('log.kicked.result')) };
    case 'spotify_fallback':
      return {
        who: 'Spotify',
        action: esc(t('log.spotify_fallback.action', { device: entry.device })),
        result: esc(t('log.spotify_fallback.result')),
      };
  }
  // An event this client doesn't know yet (newer server)
  return null;
}

/**
 * Newest first, matching the game-log panel. Names, titles and devices come from players or
 * Spotify, so the finished texts are escaped before they become HTML.
 */
export function renderGameLog(entries: GameLogEntry[] | undefined, t: TFunction): RenderedLogEntry[] {
  if (!entries?.length) return [];

  return [...entries].reverse().flatMap((entry): RenderedLogEntry[] => {
    if (isGameLogFlipLine(entry)) {
      const title = escapeHtml(entry.title);
      const html = entry.correct
        ? `<span class="log-highlight">${title}</span> — <span class="log-correct">${escapeHtml(t('log.flip.correct'))}</span>`
        : `<span class="log-highlight">${title}</span> — <span class="log-wrong">${escapeHtml(t('log.flip.wrong'))}</span>`;
      return [{ id: entry.id, html }];
    }
    // Unknown shape (other server version) — skip rather than crash
    const line = typeof entry.event === 'string' ? describe(entry, t) : null;
    if (!line) return [];
    const { who, action, result } = line;
    return [{
      id: entry.id,
      html: `<span class="log-who">${who}</span> <span class="log-action">${action}</span> — <span class="log-result">${result}</span>`,
    }];
  });
}
