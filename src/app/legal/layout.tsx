import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Legal — Datellix",
  description: "Terms of Service and Privacy Policy for Datellix.",
};

/**
 * Layout for the /legal/* routes (Terms & Privacy).
 *
 * These pages are public (no auth required) and rendered with a plain,
 * readable document-style layout — no app sidebar. A small header carries
 * the Datellix wordmark linking home; a small footer links between the two
 * legal documents.
 */
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link
            href="/"
            className="font-display text-lg font-semibold tracking-tight"
          >
            Datellix
          </Link>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link
              href="/legal/terms"
              className="transition-colors hover:text-foreground"
            >
              Terms
            </Link>
            <Link
              href="/legal/privacy"
              className="transition-colors hover:text-foreground"
            >
              Privacy
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-6 text-xs text-muted-foreground">
          <p>
            © {new Date().getFullYear()} Datellix. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}
