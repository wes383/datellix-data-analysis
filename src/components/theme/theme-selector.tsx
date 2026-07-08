"use client";

import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/components/theme/theme-provider";
import { cn } from "@/lib/utils";

/**
 * Three-option theme selector for the Settings page — Light / Dark / System.
 *
 * Rendered as a segmented control so the active preference is visible at a
 * glance (the sidebar uses a single-button toggle instead). The selected
 * segment is highlighted; "system" reflects the OS preference live.
 */
const OPTIONS: ReadonlyArray<{
  value: Theme;
  icon: typeof Sun;
  labelKey: "light" | "dark" | "system";
}> = [
  { value: "light", icon: Sun, labelKey: "light" },
  { value: "dark", icon: Moon, labelKey: "dark" },
  { value: "system", icon: Monitor, labelKey: "system" },
];

export function ThemeSelector({ className }: { className?: string }) {
  const t = useTranslations("Theme");
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label={t("label")}
      className={cn(
        "inline-flex w-full max-w-sm rounded-md border border-input bg-background p-0.5",
        className,
      )}
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const isActive = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => setTheme(opt.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              isActive
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
            title={t(opt.labelKey)}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span>{t(opt.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
