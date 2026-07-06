import { defineRouting } from "next-intl/routing";

/**
 * Supported locales. `en` is the default and must always be first.
 *
 * Adding a new locale:
 *   1. Add the code to `locales` below.
 *   2. Create `src/messages/{code}.json` (copy from `en.json` and translate).
 *   3. Add the code to the `LanguageSwitcher` component.
 *
 * Locale codes follow BCP 47 (lowercase two-letter language subtag).
 */
export const LOCALES = ["en", "zh", "es"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Locale routing config used by next-intl middleware helpers.
 * Currently consumed directly by our custom middleware (see middleware.ts)
 * rather than next-intl's `createMiddleware`, but kept here as the single
 * source of truth for locale metadata.
 */
export const routing = defineRouting({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  // Always show the locale prefix in the URL — better for SEO and shareable
  // links (no implicit locale resolution after the initial redirect).
  localePrefix: "always",
});

/**
 * Type guard: is the given string a valid locale?
 */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Match a pathname against known locales. Returns the matched locale or null.
 * Kept for compatibility with any code that wants to use next-intl's matcher.
 */
export function matchLocale(pathname: string): Locale | null {
  for (const loc of LOCALES) {
    if (pathname === `/${loc}`) return loc;
    if (pathname.startsWith(`/${loc}/`)) return loc;
  }
  return null;
}

/** Human-readable display names for each locale (in that locale's own language). */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "中文",
  es: "Español",
};
