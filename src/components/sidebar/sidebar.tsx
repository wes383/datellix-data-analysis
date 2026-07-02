"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteSession, signOut } from "@/app/actions/sessions";
import type { Session } from "@/lib/db/schema";

interface SidebarProps {
  sessions: Pick<Session, "id" | "title" | "updated_at">[];
  userEmail: string | null;
}

export function Sidebar({ sessions, userEmail }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

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

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card">
      {/* Brand */}
      <div className="px-4 py-4">
        <h1 className="font-brand text-lg font-bold tracking-tight">
          Datellix
        </h1>
      </div>

      {/* New session */}
      <div className="px-3 pb-3">
        <Button
          onClick={handleNew}
          size="default"
          variant="outline"
          className="w-full justify-start rounded-lg border-border bg-background text-base font-medium hover:bg-accent"
        >
          <Plus className="h-4 w-4" />
          New session
        </Button>
      </div>

      {/* Session list */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        <p className="px-2 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Sessions
        </p>
        <ul className="space-y-0.5">
          {sessions.length === 0 ? (
            <li className="px-2 py-2 text-xs text-muted-foreground">
              No sessions yet.
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
                    {s.title ?? "Untitled session"}
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => handleDelete(e, s.id)}
                    className="shrink-0 p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                    aria-label="Delete session"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </nav>

      {/* Footer — user + sign out */}
      <div className="border-t border-border px-3 py-3">
        <p className="mb-2 truncate font-sans text-xs text-muted-foreground">
          {userEmail ?? "Signed in"}
        </p>
        <form action={signOut}>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="w-full justify-center"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </form>
      </div>
    </aside>
  );
}
