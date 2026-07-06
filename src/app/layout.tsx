import "./globals.css";
import type { ReactNode } from "react";

/**
 * Root layout — minimal HTML shell.
 *
 * The locale-aware layout (with NextIntlClientProvider, Toaster, etc.) lives
 * in `src/app/[locale]/layout.tsx`. This root layout only sets the html/body
 * scaffolding so the [locale] segment can render its own providers.
 *
 * The `lang` attribute is set dynamically by the [locale] layout via
 * `setRequestLocale` + the html element being rendered there. We set a
 * default of `en` here as a fallback before the locale layout runs.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
