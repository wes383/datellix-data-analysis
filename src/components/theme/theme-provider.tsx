"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Theme provider — class-based dark mode for Tailwind (`darkMode: ["class"]`).
 *
 * Three preferences are supported:
 *   - "light"   → always light
 *   - "dark"    → always dark
 *   - "system"  → follows `prefers-color-scheme`, updates live when the OS
 *                 preference changes
 *
 * The active palette is applied by toggling the `dark` class on
 * `<html>`. A separate inline script (exported as `themeInitScript`) runs
 * before hydration to set the class from localStorage / system preference,
 * avoiding a flash of the wrong theme on first paint.
 *
 * Design follows the next-themes pattern (the de-facto standard) but is
 * kept dependency-free and tailored to this project's CSS variable setup.
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /** The user's preference (may be "system"). */
  theme: Theme;
  /** The palette actually applied right now (never "system"). */
  resolvedTheme: ResolvedTheme;
  /** Set the preference and persist it. */
  setTheme: (theme: Theme) => void;
  /** Toggle between light and dark (resolves "system" to its current value
   *  first, then flips). Handy for single-button toggles. */
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** localStorage key for the user's theme preference. */
const STORAGE_KEY = "theme";

/** Media query used to detect the OS-level colour scheme. */
const DARK_MEDIA = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(DARK_MEDIA).matches;
}

function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return theme;
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  // Keep the native form-control color scheme in sync so native <input
  // type="date">, scrollbars on form elements, etc. match the palette.
  root.style.colorScheme = resolved;
}

/**
 * Inline script injected into <head> before hydration. Reads the stored
 * preference (or system preference as a fallback) and sets the `dark` class
 * synchronously, so the very first paint uses the correct palette.
 *
 * The script is intentionally tiny and stringified so it can be rendered
 * via a <script> tag in the server component root layout.
 */
export const themeInitScript = `(function(){try{var k='${STORAGE_KEY}';var s=localStorage.getItem(k);var m=window.matchMedia('${DARK_MEDIA}').matches;var d=s==='dark'||((!s||s==='system')&&m);var e=document.documentElement;if(d){e.classList.add('dark');}else{e.classList.remove('dark');}e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

interface ThemeProviderProps {
  children: ReactNode;
  /** Default preference when nothing is stored yet. */
  defaultTheme?: Theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: ThemeProviderProps) {
  // Start with the default; the real value is read from localStorage in an
  // effect. This avoids an SSR/client mismatch (the server can't know the
  // stored value) while the inline script already applied the right class
  // before React mounts.
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // On mount: read the stored preference and sync internal state with the
  // class the inline script already applied.
  useEffect(() => {
    let stored: Theme = defaultTheme;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === "light" || raw === "dark" || raw === "system") {
        stored = raw;
      }
    } catch {
      // ignore storage access failures (private mode, etc.)
    }
    setThemeState(stored);
    const resolved = resolveTheme(stored);
    setResolvedTheme(resolved);
    applyTheme(resolved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the preference is "system", keep the palette in sync with the OS
  // preference as it changes (e.g. user toggles dark mode at the OS level).
  useEffect(() => {
    if (theme !== "system") return;
    const mql = window.matchMedia(DARK_MEDIA);
    function onChange(e: MediaQueryListEvent) {
      const resolved: ResolvedTheme = e.matches ? "dark" : "light";
      setResolvedTheme(resolved);
      applyTheme(resolved);
    }
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore storage write failures
    }
    const resolved = resolveTheme(next);
    setResolvedTheme(resolved);
    applyTheme(resolved);
  }, []);

  const toggleTheme = useCallback(() => {
    // Flip relative to the *resolved* palette so a "system" user still gets
    // a sensible toggle (system-dark → light, system-light → dark).
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/** Access the current theme and updater. Must be used inside <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
