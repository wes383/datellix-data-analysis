import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Auth middleware: refresh session + block unauthenticated access
 * - /login, /legal/*, and static assets are allowed through
 * - Other paths redirect to /login if not authenticated
 */
export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

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
            // Request cookies only accept (key, value); options go on response cookies
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

  const pathname = req.nextUrl.pathname;
  const isLoginPage = pathname.startsWith("/login");
  // Legal pages (Terms, Privacy) are public — linked from the signup flow
  // and the settings page, so they must be reachable without auth.
  const isLegalPage = pathname.startsWith("/legal");

  // Not authenticated and accessing protected path → redirect to login
  if (!user && !isLoginPage && !isLegalPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Authenticated but accessing login page → redirect to home
  if (user && isLoginPage) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: [
    /*
     * Match all paths, excluding:
     * - _next/static, _next/image, favicon.ico
     * - /api (API routes handle their own auth)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$|api).*)",
  ],
};
