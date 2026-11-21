import { LANGS, useLang, useT } from './index';

/** Compact "DE | EN" toggle for the headers (entry page, lobby/round, TV). */
export function LanguageSwitcher() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className="lang-switch" role="group" aria-label={t('lang.label')} data-testid="lang-switch">
      {LANGS.map(l => (
        <button
          key={l}
          type="button"
          lang={l}
          className={`lang-switch-btn${l === lang ? ' is-active' : ''}`}
          aria-pressed={l === lang}
          title={t(l === 'de' ? 'lang.de' : 'lang.en')}
          onClick={() => setLang(l)}
          data-testid={`lang-${l}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
