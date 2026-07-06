import type { Metadata } from "next";
import { Link } from "@/i18n/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";

interface Props {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const t = await getTranslations({ locale, namespace: "Metadata" });
  const tl = await getTranslations({ locale, namespace: "Legal" });
  return {
    title: tl("metadataLegalTitle", { appTitle: t("appTitle") }),
    description: tl("metadataLegalDescription"),
  };
}

/**
 * Layout for the /legal/* routes (Terms & Privacy).
 *
 * These pages are public (no auth required) and rendered with a plain,
 * readable document-style layout — no app sidebar. A small header carries
 * the Datellix wordmark linking home; a small footer links between the two
 * legal documents.
 */
export default async function LegalLayout({ children, params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const tl = await getTranslations("Legal");
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
              {tl("navTerms")}
            </Link>
            <Link
              href="/legal/privacy"
              className="transition-colors hover:text-foreground"
            >
              {tl("navPrivacy")}
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-6 py-6 text-xs text-muted-foreground">
          <p>
            {tl("footerCopyright", { year: new Date().getFullYear() })}
          </p>
        </div>
      </footer>
    </div>
  );
}
