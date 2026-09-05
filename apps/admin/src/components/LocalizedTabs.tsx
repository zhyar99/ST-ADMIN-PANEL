import { useState, type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@streaming/shared';

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  ckb: 'Kurdish Sorani',
  ar: 'Arabic',
};

/** Sorani and Arabic are right-to-left; inputs for them must say so. */
export const LOCALE_DIRECTION: Record<SupportedLocale, 'ltr' | 'rtl'> = {
  en: 'ltr',
  ckb: 'rtl',
  ar: 'rtl',
};

interface LocalizedTabsProps {
  /** Rendered once per locale — only the active one is mounted. */
  children: (locale: SupportedLocale) => ReactNode;
  /**
   * Locales with a validation error. They get a marker on the tab, because a
   * required Arabic field failing on a hidden tab is otherwise invisible.
   */
  invalidLocales?: SupportedLocale[];
}

export default function LocalizedTabs({ children, invalidLocales = [] }: LocalizedTabsProps) {
  const [active, setActive] = useState<SupportedLocale>('en');

  return (
    <div>
      <div role="tablist" className="flex gap-1 border-b border-slate-800">
        {SUPPORTED_LOCALES.map((locale) => {
          const isActive = locale === active;
          const hasError = invalidLocales.includes(locale);

          return (
            <button
              key={locale}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActive(locale)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
                isActive
                  ? 'border-slate-200 text-slate-100'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {LOCALE_LABELS[locale]}
              {hasError && <AlertCircle size={13} className="text-rose-400" aria-label="Has errors" />}
            </button>
          );
        })}
      </div>

      <div className="pt-4" dir={LOCALE_DIRECTION[active]}>
        {children(active)}
      </div>
    </div>
  );
}
