import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang } from '../../../shared/types';
import { de, type Messages, type MessageKey, type Plural } from './de';
import { en } from './en';

export type { Lang, MessageKey };

/** Interpolation values: `{name}` in a message is replaced by `params.name`. `count` picks the plural form. */
export type TParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: TParams) => string;

export const LANGS: readonly Lang[] = ['de', 'en'];
export const DEFAULT_LANG: Lang = 'de';
const STORAGE_KEY = 'hitster_lang';

const DICTIONARIES: Record<Lang, Messages> = { de, en };

function readStoredLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'de' ? stored : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Private mode / blocked storage — the choice just isn't remembered
  }
}

/** Current language for code outside React (e.g. the Spotify login URL). Kept in sync by the provider. */
let currentLang: Lang = readStoredLang();
export function getLang(): Lang {
  return currentLang;
}

function pick(template: string | Plural, params?: TParams): string {
  if (typeof template === 'string') return template;
  return Number(params?.count) === 1 ? template.one : template.other;
}

/** Look up a message and fill in its `{placeholders}`. */
export function translate(lang: Lang, key: MessageKey, params?: TParams): string {
  const template = pick(DICTIONARIES[lang][key], params);
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue>({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key, params) => translate(DEFAULT_LANG, key, params),
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang);

  useEffect(() => {
    currentLang = lang;
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    currentLang = next;
    storeLang(next);
    setLangState(next);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }),
    [lang, setLang],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `t(key, params?)` in the current language. */
export function useT(): TFunction {
  return useContext(I18nContext).t;
}

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
  const { lang, setLang } = useContext(I18nContext);
  return { lang, setLang };
}

/**
 * Put elements into a translated text: `{url}` placeholders left open by `t()` are replaced
 * by `nodes.url` (e.g. a <strong>), so word order stays up to each language.
 */
export function withNodes(text: string, nodes: Record<string, ReactNode>): ReactNode {
  return text.split(/\{(\w+)\}/).map((part, i) =>
    i % 2 === 1 ? <Fragment key={i}>{part in nodes ? nodes[part] : `{${part}}`}</Fragment> : part,
  );
}
