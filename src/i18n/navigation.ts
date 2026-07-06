/**
 * Locale-aware navigation helpers.
 *
 * Re-export of next-intl's `createNavigation` factories. Use these instead
 * of `next/link` and `next/navigation` to get automatic locale-prefix
 * injection on every link and programmatic navigation.
 *
 * Usage:
 *   import { Link, useRouter, usePathname, redirect } from "@/i18n/navigation";
 *
 * `<Link href="/login">` → renders `/zh/login` (or current locale)
 * `router.push("/chat/new")` → navigates to `/{locale}/chat/new`
 */

import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

// `createNavigation` returns locale-aware versions of next/link and the
// next/navigation hooks. They take the routing config and produce navigation
// primitives that automatically prepend the current locale to hrefs.
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
