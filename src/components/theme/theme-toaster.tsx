"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/components/theme/theme-provider";

/**
 * Theme-aware Toaster — wires sonner's `theme` prop to the resolved palette
 * so toasts match the active light/dark scheme instead of always rendering
 * in light mode. Replaces the previously hardcoded `theme="light"` Toaster.
 *
 * Must be rendered inside <ThemeProvider> (it is, via the locale layout).
 */
export function ThemeToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <Toaster
      position="top-right"
      theme={resolvedTheme}
      // No inline styles — sonner reads our CSS variables (background,
      // foreground, border) via its `toastOptions.className`, so toasts
      // stay consistent with the rest of the UI in both palettes.
      toastOptions={{}}
    />
  );
}
