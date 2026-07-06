import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LOCALES, DEFAULT_LOCALE, type Locale } from "@/i18n/routing";

/**
 * Root redirect: `/` → `/{locale}`.
 *
 * `middleware.ts` already handles this redirect for browser requests, but
 * Next.js dev/edge occasionally bypasses middleware for the bare root in
 * some caching or routing edge cases. This server component is a safety
 * net that always performs the redirect, mirroring the middleware's
 * Accept-Language + NEXT_LOCALE cookie negotiation.
 *
 * Note: cookies() is async in Next 15+ and not needed here — middleware
 * already persisted NEXT_LOCALE before this runs, so we just consult
 * Accept-Language as a fallback.
 */
function negotiateLocale(acceptLanguage: string | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const preferred = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, q = "1"] = part.trim().split(";q=");
      return { tag: tag.trim().toLowerCase(), q: Number(q) };
    })
    .sort((a, b) => b.q - a.q);
  for (const { tag } of preferred) {
    if (LOCALES.includes(tag as Locale)) return tag as Locale;
    const prefix = tag.split("-")[0]!;
    if (LOCALES.includes(prefix as Locale)) return prefix as Locale;
  }
  return DEFAULT_LOCALE;
}

export default async function RootPage() {
  const acceptLanguage = (await headers()).get("Accept-Language");
  const target = negotiateLocale(acceptLanguage);
  redirect(`/${target}`);
}
