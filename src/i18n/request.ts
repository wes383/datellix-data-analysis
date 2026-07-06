import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { type Locale, LOCALES, DEFAULT_LOCALE, isLocale } from "./routing";

/**
 * Per-request i18n config. Loads the message bundle for the current locale.
 *
 * Locale resolution priority:
 *   1. `requestLocale` — set by `setRequestLocale(locale)` in the
 *      [locale]/layout.tsx (or any server component). This is the URL
 *      segment locale and is always authoritative for page renders.
 *   2. `NEXT_LOCALE` cookie — fallback for routes that don't have a
 *      locale segment (API routes, server actions).
 *   3. `DEFAULT_LOCALE` — last resort.
 *
 * IMPORTANT: we must consume `requestLocale` first. The previous version
 * read only the cookie, which caused the URL locale (e.g. /zh/...) to be
 * ignored when the cookie was stale or absent in the same request —
 * resulting in the correct URL prefix but English messages being loaded.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  let locale: Locale = DEFAULT_LOCALE;

  // 1. Highest priority: the locale set via setRequestLocale() in the
  //    [locale]/layout.tsx. This reflects the URL segment (/zh, /es, ...).
  const requested = await requestLocale;
  if (typeof requested === "string" && isLocale(requested)) {
    locale = requested;
  } else {
    // 2. Fallback: NEXT_LOCALE cookie (for API routes / server actions
    //    that don't have a locale URL segment).
    try {
      const cookieStore = await cookies();
      const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
      if (cookieLocale && isLocale(cookieLocale)) {
        locale = cookieLocale;
      }
    } catch {
      // cookies() may throw outside of a request scope — fall back to default.
    }
  }

  // 3. Validate (defensive — cookie could be tampered).
  const finalLocale: Locale = (LOCALES as readonly string[]).includes(locale)
    ? locale
    : DEFAULT_LOCALE;

  return {
    locale: finalLocale,
    messages: (await import(`../messages/${finalLocale}.json`)).default,
  };
});
