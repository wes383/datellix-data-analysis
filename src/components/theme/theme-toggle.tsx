"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/theme/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Theme toggle — a single icon button that flips between light and dark.
 *
 * Renders nothing on the server and until the provider has hydrated, so the
 * icon shown always matches the palette that the no-FOUC script applied
 * (avoids an SSR/client mismatch where the wrong icon would briefly appear).
 *
 * Variants mirror `LanguageSwitcher`:
 *   - "ghost" (default): transparent button — for compact spots like the
 *     sidebar footer and the login panel header
 *   - "outline": bordered input-style button — for forms / settings rows
 */
type Variant = "ghost" | "outline";

export function ThemeToggle({
  className,
  variant = "ghost",
}: {
  className?: string;
  variant?: Variant;
}) {
  const t = useTranslations("Theme");
  const { resolvedTheme, toggleTheme } = useTheme();
  // Don't render an icon until hydrated: the server can't know which palette
  // the inline script chose, so rendering either icon eagerly would flash.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  const buttonClass = cn(
    "flex items-center justify-center gap-2 text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    variant === "outline"
      ? cn(
          "h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground",
          "hover:border-primary/50",
        )
      : cn(
          "h-8 w-8 rounded-md text-muted-foreground",
          "hover:bg-accent/50 hover:text-foreground",
        ),
    className,
  );

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={buttonClass}
      aria-label={isDark ? t("switchToLight") : t("switchToDark")}
      title={isDark ? t("switchToLight") : t("switchToDark")}
    >
      {mounted ? (
        isDark ? (
          <Sun className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Moon className="h-3.5 w-3.5 shrink-0" />
        )
      ) : (
        // Placeholder keeps layout stable before hydration.
        <span className="h-3.5 w-3.5 shrink-0" />
      )}
      {variant === "outline" && (
        <span className="truncate">
          {mounted ? (isDark ? t("dark") : t("light")) : "\u00a0"}
        </span>
      )}
    </button>
  );
}
