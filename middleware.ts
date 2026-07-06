import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { rateLimit, getClientIp, LIMITS, rateLimitHeaders } from "@/lib/ratelimit/limiter";
import { matchLocale, type Locale, LOCALES, DEFAULT_LOCALE } from "@/i18n/routing";

/**
 * Combined middleware:
 *
 * 1. Locale routing — negotiates the user's preferred locale from
 *    Accept-Language + a `NEXT_LOCALE` cookie, then redirects paths without
 *    a locale prefix to `/{locale}/...`. Public paths (/login, /legal) and
 *    app paths alike are localised.
 *
 * 2. API rate limiting — applies a global per-IP sliding-window limiter to
 *    every `/api/*` route. Routes that need stricter limits (e.g. OTP
 *    endpoints) apply their own limiter inside the handler on top of this
 *    global net.
 *
 * 3. Auth — refreshes the Supabase session cookie and blocks unauthenticated
 *    access to protected paths. /login, /legal/* are public.
 */

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Paths that should bypass the locale-prefix redirect (static assets etc.). */
const STATIC_ASSET_RE = /^\/(_next\/static|_next\/image|favicon\.ico|.*\.(?:svg|png|jpg|jpeg|gif|webp))$/;

/** Read Accept-Language header and pick the best supported locale. */
function negotiateLocale(acceptLanguage: string | null, cookieLocale: string | null): Locale {
  // 1. Cookie wins if it's a valid locale (user explicitly chose before).
  if (cookieLocale && LOCALES.includes(cookieLocale as Locale)) {
    return cookieLocale as Locale;
  }
  // 2. Parse Accept-Language: "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7"
  if (acceptLanguage) {
    const preferred = acceptLanguage
      .split(",")
      .map((part) => {
        const [tag, q = "1"] = part.trim().split(";q=");
        return { tag: tag.trim().toLowerCase(), q: Number(q) };
      })
      .sort((a, b) => b.q - a.q);
    for (const { tag } of preferred) {
      // Exact match (e.g. "zh", "es", "en")
      if (LOCALES.includes(tag as Locale)) return tag as Locale;
      // Prefix match (e.g. "zh-cn" → "zh", "es-mx" → "es", "en-us" → "en")
      const prefix = tag.split("-")[0]!;
      if (LOCALES.includes(prefix as Locale)) return prefix as Locale;
    }
  }
  // 3. Fallback to default.
  return DEFAULT_LOCALE;
}

/** Strip the leading /{locale} segment from a pathname, if present. */
function stripLocale(pathname: string): { locale: Locale | null; rest: string } {
  for (const loc of LOCALES) {
    if (pathname === `/${loc}`) return { locale: loc as Locale, rest: "/" };
    if (pathname.startsWith(`/${loc}/`)) {
      return { locale: loc as Locale, rest: pathname.slice(`/${loc}`.length) };
    }
  }
  return { locale: null, rest: pathname };
}

/* ------------------------------------------------------------------ */
/*  Middleware                                                          */
/* ------------------------------------------------------------------ */

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;

  /* -------------------------------------------------------------- */
  /*  1. Global API rate limiting (skip static assets)               */
  /* -------------------------------------------------------------- */
  if (pathname.startsWith("/api") && !STATIC_ASSET_RE.test(pathname)) {
    const ip = getClientIp(req.headers);
    const rl = await rateLimit(ip, LIMITS.API_GLOBAL);
    if (!rl.ok) {
      const retryAfterSec = Math.ceil((rl.resetAt - Date.now()) / 1000);
      return NextResponse.json(
        { error: "Rate limit exceeded. Please slow down." },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfterSec),
            ...rateLimitHeaders(rl),
          },
        },
      );
    }
    // Continue to the API route handler. Attach rate-limit headers to the
    // response so clients can introspect their quota.
    const res = NextResponse.next();
    Object.entries(rateLimitHeaders(rl)).forEach(([k, v]) => {
      res.headers.set(k, v);
    });
    // Auth refresh (Supabase session cookie) — same as below, but for API
    // routes we don't redirect, just refresh.
    return refreshSession(req, res);
  }

  /* -------------------------------------------------------------- */
  /*  2. Locale routing                                              */
  /* -------------------------------------------------------------- */
  if (STATIC_ASSET_RE.test(pathname)) {
    // Static asset — no locale, no auth, just pass through.
    return NextResponse.next();
  }

  const cookieLocale = req.cookies.get("NEXT_LOCALE")?.value ?? null;
  const { locale: existingLocale, rest } = stripLocale(pathname);

  if (!existingLocale) {
    // No locale prefix → negotiate and redirect to /{locale}{rest}
    const target = negotiateLocale(req.headers.get("Accept-Language"), cookieLocale);
    const url = req.nextUrl.clone();
    url.pathname = `/${target}${rest === "/" ? "" : rest}`;
    const res = NextResponse.redirect(url);
    // Persist the chosen locale so subsequent visits skip negotiation.
    res.cookies.set("NEXT_LOCALE", target, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365, // 1 year
      sameSite: "lax",
    });
    return res;
  }

  /* -------------------------------------------------------------- */
  /*  3. Auth (Supabase session refresh + redirect)                 */
  /* -------------------------------------------------------------- */
  const res = NextResponse.next();
  // Persist the locale cookie whenever a valid locale is in the URL.
  if (!cookieLocale || cookieLocale !== existingLocale) {
    res.cookies.set("NEXT_LOCALE", existingLocale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }

  return refreshSession(req, res, rest);
}

/**
 * Refresh the Supabase session cookie and apply auth redirect logic.
 * `pathWithoutLocale` is the pathname with the /{locale} prefix stripped,
 * used for matching public/protected routes.
 */
async function refreshSession(
  req: NextRequest,
  res: NextResponse,
  pathWithoutLocale?: string,
): Promise<NextResponse> {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            req.cookies.set(name, value);
            res.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Determine the path to test against, accounting for locale prefix.
  const path = pathWithoutLocale ?? req.nextUrl.pathname;
  const isLoginPage = path.startsWith("/login");
  const isLegalPage = path.startsWith("/legal");

  // Not authenticated and accessing protected path → redirect to /login
  // (preserving the current locale).
  if (!user && !isLoginPage && !isLegalPage) {
    const { locale } = stripLocale(req.nextUrl.pathname);
    const loc = locale ?? DEFAULT_LOCALE;
    const url = req.nextUrl.clone();
    url.pathname = `/${loc}/login`;
    return NextResponse.redirect(url);
  }

  // Authenticated but accessing login page → redirect to home (locale-aware)
  if (user && isLoginPage) {
    const { locale } = stripLocale(req.nextUrl.pathname);
    const loc = locale ?? DEFAULT_LOCALE;
    const url = req.nextUrl.clone();
    url.pathname = `/${loc}`;
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match all paths, excluding:
     * - _next/static, _next/image, favicon.ico, image files
     * (API routes ARE matched now — we apply global rate limit there)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
