import { cleanTrackTitle, isSuspiciousRelease, parseLabel, songKey } from './labels';

describe('parseLabel', () => {
  it.each([
    ['80s', { from: 1980, to: 1989 }, ''],
    ["80's", { from: 1980, to: 1989 }, ''],
    ['80er', { from: 1980, to: 1989 }, ''],
    ['1990s', { from: 1990, to: 1999 }, ''],
    ['2000er Hits', { from: 2000, to: 2009 }, ''],
    ['10s', { from: 2010, to: 2019 }, ''],
    ['60s', { from: 1960, to: 1969 }, ''],
    ['1975-1985', { from: 1975, to: 1985 }, ''],
    ['1985', { from: 1985, to: 1985 }, ''],
    ["90's Rock", { from: 1990, to: 1999 }, 'rock'],
    ['90er Jahre Hip Hop', { from: 1990, to: 1999 }, 'hip hop'],
    ['Y2K Pop', { from: 1998, to: 2004 }, 'pop'],
  ])('%s', (label, range, topic) => {
    expect(parseLabel(label)).toEqual({ range, topic });
  });

  it('keeps genre-only labels as topic', () => {
    expect(parseLabel('Schlager')).toEqual({ range: null, topic: 'schlager' });
    expect(parseLabel('Best of Classic Rock')).toEqual({ range: null, topic: 'rock' });
    expect(parseLabel('Greatest Hits')).toEqual({ range: null, topic: '' });
  });
});

describe('cleanTrackTitle', () => {
  it.each([
    ['Hotel California - 2013 Remaster', 'Hotel California'],
    ['Wonderwall - Remastered', 'Wonderwall'],
    ['Africa (Remastered 2019)', 'Africa'],
    ['Starman (Original Single Mix)', 'Starman'],
    ['Help! - Mono', 'Help!'],
    ['Purple Rain', 'Purple Rain'],
    ['Sunflower - Spider-Man: Into the Spider-Verse', 'Sunflower - Spider-Man: Into the Spider-Verse'],
    ['Rocket Man (I Think It\'s Going To Be A Long, Long Time)', 'Rocket Man (I Think It\'s Going To Be A Long, Long Time)'],
  ])('%s', (input, expected) => {
    expect(cleanTrackTitle(input)).toBe(expected);
  });
});

describe('isSuspiciousRelease', () => {
  it('flags remasters, compilations and live albums', () => {
    expect(isSuspiciousRelease('Hotel California - 2013 Remaster', '')).toBe(true);
    expect(isSuspiciousRelease('Starman (Original Single Mix)', '')).toBe(true);
    expect(isSuspiciousRelease('Africa', 'Toto IV', 'compilation')).toBe(true);
    expect(isSuspiciousRelease('Layla', 'The Cream of Clapton (Greatest Hits)')).toBe(true);
    expect(isSuspiciousRelease('Africa', 'Toto IV', 'album')).toBe(false);
  });
});

describe('songKey', () => {
  it('matches versions of the same song', () => {
    expect(songKey('Hotel California - 2013 Remaster', 'Eagles')).toBe(songKey('Hotel California', 'Eagles, X'));
    expect(songKey('Africa', 'TOTO')).not.toBe(songKey('Rosanna', 'TOTO'));
  });
});
