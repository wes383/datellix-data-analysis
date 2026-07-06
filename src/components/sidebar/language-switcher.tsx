"use client";

import { useState, useRef, useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, usePathname } from "@/i18n/navigation";
import { Globe, Check, ChevronDown } from "lucide-react";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/**
 * Language switcher — a button that opens a dropdown listing the supported
 * locales. Selecting one navigates to the same path under the new locale
 * (next-intl's `useRouter.replace` swaps the prefix automatically).
 *
 * Persisted via the `NEXT_LOCALE` cookie (set in middleware) so the choice
 * survives reloads and applies to future sessions.
 *
 * Dropdown convention follows `src/components/ui/select.tsx`:
 *   - `useState(open)` + `useRef(container)` + outside-click/Escape effect
 *   - `cn()` for class composition
 *   - `aria-haspopup="menu"` + `aria-expanded`
 *   - Rotating `ChevronDown` indicator on the trigger
 *   - Opens downward (top-full mt-1)
 *
 * Variants (mirrors select.tsx):
 *   - "outline" (default): bordered input-style button — for settings/forms
 *   - "ghost": transparent button — for compact headers like the login panel
 */
type Variant = "outline" | "ghost";

export function LanguageSwitcher({
  className,
  variant = "outline",
}: {
  className?: string;
  variant?: Variant;
}) {
  const t = useTranslations("LanguageSwitcher");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape (matches the select.tsx convention).
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function selectLocale(next: Locale) {
    setOpen(false);
    if (next === locale) return;
    // next-intl's router.replace swaps the locale segment of the URL while
    // preserving the rest of the path and query string. The cookie is set
    // by the middleware on the next request.
    router.replace(pathname, { locale: next });
  }

  const triggerClass = cn(
    "flex w-full items-center justify-between gap-2 text-sm transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    variant === "outline"
      ? cn(
          "h-10 rounded-md border border-input bg-background px-3 py-2 text-foreground",
          "hover:border-primary/50",
        )
      : cn(
          "h-8 rounded-md px-2 py-1.5 text-muted-foreground",
          "hover:bg-accent/50 hover:text-foreground",
        ),
  );

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={triggerClass}
        aria-label={t("changeLanguage")}
        title={t("changeLanguage")}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{LOCALE_LABELS[locale]}</span>
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ul
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 w-full min-w-[180px] overflow-hidden rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {LOCALES.map((loc) => {
            const isSelected = loc === locale;
            return (
              <li key={loc} role="menuitem">
                <button
                  type="button"
                  onClick={() => selectLocale(loc as Locale)}
                  className={cn(
                    "flex w-full items-center justify-between px-3 py-1.5 text-sm transition-colors",
                    isSelected
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <span>{LOCALE_LABELS[loc as Locale]}</span>
                  <Check
                    className={cn(
                      "h-3 w-3",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
