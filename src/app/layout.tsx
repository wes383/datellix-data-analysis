import "./globals.css";
import type { ReactNode } from "react";
import { themeInitScript } from "@/components/theme/theme-provider";

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
 *
 * A tiny inline script runs before hydration to apply the saved theme
 * (light/dark) to <html>, preventing a flash of the wrong palette. The
 * <html> element carries `suppressHydrationWarning` because that script
 * mutates the class list before React hydrates.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          // eslint-disable-next-line react/no-danger -- trusted, locally-authored string
          dangerouslySetInnerHTML={{ __html: themeInitScript }}
        />
      </head>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
