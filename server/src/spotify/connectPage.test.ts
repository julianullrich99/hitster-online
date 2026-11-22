import { connectResultHtml, parseLang } from './connectPage';

describe('Spotify Connect result page', () => {
  it('defaults to German and only switches to English on lang=en', () => {
    expect(parseLang(undefined)).toBe('de');
    expect(parseLang('fr')).toBe('de');
    expect(parseLang('en')).toBe('en');
  });

  it('renders the message in the requested language', () => {
    const de = connectResultHtml('de', 'cancelled');
    expect(de).toContain('<html lang="de">');
    expect(de).toContain('Die Spotify-Anmeldung wurde abgebrochen.');
    expect(de).toContain('Du kannst diesen Tab schließen');
    const en = connectResultHtml('en', 'cancelled');
    expect(en).toContain('Spotify login was cancelled.');
    expect(en).toContain('You can close this tab');
  });

  it('escapes the account name', () => {
    expect(connectResultHtml('en', 'connected', { name: '<b>Al</b>' })).toContain('Spotify connected as &lt;b&gt;Al&lt;/b&gt;.');
  });

  it('stores the sealed login in the browser, safely embedded', () => {
    const html = connectResultHtml('de', 'connected', { name: 'Al', saved: { accountName: '</script><b>', link: 'abc' } });
    expect(html).toContain("localStorage.setItem(\"hitster_spotify_login\"");
    expect(html).not.toContain('</script><b>');
    expect(connectResultHtml('de', 'cancelled')).not.toContain('localStorage');
  });
});
