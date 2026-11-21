import { titleMatches, artistMatches } from './naming';

describe('titleMatches', () => {
  it.each([
    ['bohemian rhapsody', 'Bohemian Rhapsody'],
    ['Bohemian Rapsody', 'Bohemian Rhapsody'],
    ['Hey Jude', 'Hey Jude - Remastered 2015'],
    ['Crazy in Love', 'Crazy In Love (feat. Jay-Z)'],
    ['dont stop me now', "Don't Stop Me Now"],
    ['99 Luftballons', '99 Luftballons'],
    ['Major Tom', 'Major Tom (völlig losgelöst)'],
    ['Mama Mia', 'Mamma Mia'],
    ['Cafe del Mar', 'Café del Mar'],
    ['rock and roll', 'Rock & Roll'],
    ['Ein Kompliment', 'Ein Kompliment'],
  ])('%s ≈ %s', (guess, title) => {
    expect(titleMatches(guess, title)).toBe(true);
  });

  it.each([
    ['Love', 'Crazy In Love'],
    ['Yesterday', 'Hey Jude'],
    ['', 'Hey Jude'],
    ['Hey', 'Hello'],
  ])('%s ≠ %s', (guess, title) => {
    expect(titleMatches(guess, title)).toBe(false);
  });
});

describe('artistMatches', () => {
  it.each([
    ['beatles', 'The Beatles'],
    ['Beyonce', 'Beyoncé, JAY-Z'],
    ['jay z', 'Beyoncé, JAY-Z'],
    ['Rihanna', 'Rihanna feat. Drake'],
    ['Calvin Harris & Dua Lipa', 'Calvin Harris, Dua Lipa'],
    ['Peter Schilling', 'Peter Schiling'],
    ['Simon and Garfunkel', 'Simon & Garfunkel'],
    ['ACDC', 'AC/DC'],
  ])('%s ≈ %s', (guess, artist) => {
    expect(artistMatches(guess, artist)).toBe(true);
  });

  it.each([
    ['Queen', 'The Beatles'],
    ['Drake', 'Rihanna'],
    ['', 'Queen'],
  ])('%s ≠ %s', (guess, artist) => {
    expect(artistMatches(guess, artist)).toBe(false);
  });
});
