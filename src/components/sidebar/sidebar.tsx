"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { usePathname, useRouter, Link } from "@/i18n/navigation";
import { useTranslations } from "next-intl";
import {
  Plus,
  Trash2,
  Database,
  BarChart3,
  Settings,
  LayoutGrid,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { deleteSession } from "@/app/actions/sessions";
import type { Session } from "@/lib/db/schema";

interface SidebarProps {
  sessions: Pick<Session, "id" | "title" | "updated_at">[];
}

/** localStorage key for the app sidebar collapse preference. Persisted so
 *  the user's choice survives page navigations and reloads. */
const COLLAPSE_KEY = "sidebar:collapsed";

export function Sidebar({ sessions }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  // Collapse state — default expanded. Hydrated from localStorage on mount
  // (avoids SSR/client mismatch by starting from a fixed value).
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      if (stored === "1") setCollapsed(true);
    } catch {
      // ignore storage access failures (private mode, etc.)
    }
    setHydrated(true);
  }, []);
  // Persist on every change (after the first hydration), and broadcast a
  // custom event so sibling components (e.g. the library page's content
  // wrapper) can adjust their layout to match the sidebar width.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("sidebar-collapse", { detail: { collapsed } }),
      );
    }
  }, [collapsed, hydrated]);

  function handleNew() {
    // Navigate to the pending new-session route — no DB row is created
    // until the first message is sent (see Chat.tsx handleSubmit).
    router.push("/chat/new");
  }

  function handleDelete(e: React.MouseEvent, sessionId: string) {
    e.preventDefault();
    e.stopPropagation();
    startTransition(async () => {
      await deleteSession(sessionId);
      // If we're viewing the deleted session, or on a page referencing it,
      // jump to a fresh pending session instead of the blank home placeholder.
      const currentQuerySessionId = searchParams.get("sessionId");
      if (
        pathname === `/chat/${sessionId}` ||
        (pathname === "/sources/new" && currentQuerySessionId === sessionId)
      ) {
        router.push("/chat/new");
      }
      router.refresh();
    });
  }

  // Fixed nav items shared between expanded and collapsed layouts.
  // Settings is rendered in the footer (bottom) instead of here, so the
  // user can reach it the way they previously reached Sign out.
  // The `href` is the locale-unaware path; next/link will preserve the
  // current locale prefix automatically because we render via the [locale]
  // segment — Next.js' built-in Link reuses the active locale.
  const navItems = [
    { href: "/sources", label: t("dataSources"), icon: Database },
    { href: "/library", label: t("chartLibrary"), icon: LayoutGrid },
    { href: "/usage", label: t("usage"), icon: BarChart3 },
  ];

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-border bg-card transition-[width] duration-200 ${
        collapsed ? "w-14" : "w-64"
      }`}
    >
      {/* Brand + collapse toggle */}
      <div className="flex items-center justify-between px-3 py-4">
        <div className={collapsed ? "hidden" : "block"}>
          <h1 className="font-brand text-lg font-bold tracking-tight">
            Datellix
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
            collapsed ? "translate-x-[3px]" : ""
          }`}
          aria-label={collapsed ? t("expandSidebar") : t("collapseSidebar")}
          title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4" />
          ) : (
            <ChevronsLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* New session + Fixed nav — all items share the same container and spacing */}
      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={handleNew}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground ${
            collapsed ? "justify-center" : ""
          }`}
          title={t("newSession")}
          aria-label={t("newSession")}
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          {collapsed ? null : <span>{t("newSession")}</span>}
        </button>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                collapsed ? "justify-center" : ""
              } ${
                isActive
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
              title={item.label}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {collapsed ? null : <span>{item.label}</span>}
            </Link>
          );
        })}
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        <p
          className={`px-2 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground ${
            collapsed ? "text-center" : ""
          }`}
        >
          {collapsed ? "···" : t("sessions")}
        </p>
        {collapsed ? (
          // Collapsed: show numbered badges (1-based) so users can distinguish
          // sessions at a glance. Numbers use Plus Jakarta Sans for legibility.
          <ul className="space-y-0.5">
            {sessions.slice(0, 8).map((s, idx) => {
              const active = pathname === `/chat/${s.id}`;
              return (
                <li key={s.id}>
                  <Link
                    href={`/chat/${s.id}`}
                    className={`flex h-7 w-full items-center justify-center rounded-md transition-colors ${
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    }`}
                    title={s.title ?? t("untitledSession")}
                  >
                    <span
                      style={{ fontFamily: '"Plus Jakarta Sans", "Inter", system-ui, sans-serif' }}
                      className="text-xs font-semibold leading-none"
                    >
                      {idx + 1}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="space-y-0.5">
            {sessions.length === 0 ? (
              <li className="px-2 py-2 text-xs text-muted-foreground">
                {t("noSessions")}
              </li>
            ) : (
              sessions.map((s) => {
                const active = pathname === `/chat/${s.id}`;
                return (
                  <li
                    key={s.id}
                    className={`group flex items-center gap-1 rounded-md px-2 ${
                      active ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                  >
                    <Link
                      href={`/chat/${s.id}`}
                      className={`flex-1 truncate py-2 text-sm ${
                        active
                          ? "font-medium text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {s.title ?? t("untitledSession")}
                    </Link>
                    <button
                      type="button"
                      onClick={(e) => handleDelete(e, s.id)}
                      className="shrink-0 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                      aria-label={t("deleteSession")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </nav>

      {/* Footer — Settings link (Sign out + Language switcher have moved to the Settings page) */}
      <div className="border-t border-border px-2 py-2">
        <Link
          href="/settings"
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
            collapsed ? "justify-center" : ""
          } ${
            pathname.startsWith("/settings")
              ? "bg-accent font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
          title={t("settings")}
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          {collapsed ? null : <span>{t("settings")}</span>}
        </Link>
      </div>
    </aside>
  );
}
