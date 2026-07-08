import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn/ui className merge utility */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Resolve the active theme's card colour to a concrete `hsl(...)` string.
 *
 * Used by chart PNG export (`html-to-image`'s `backgroundColor` option needs
 * a concrete colour — it fills a canvas, so CSS variables don't resolve
 * there). Reads the `--card` variable from the document root so the export
 * background matches whatever palette is currently applied (light or dark),
 * keeping chart text legible in the exported image. Falls back to white if
 * the variable can't be read (e.g. during SSR).
 */
export function getThemeCardColor(): string {
  if (typeof window === "undefined") return "#ffffff";
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue("--card")
    .trim();
  return raw ? `hsl(${raw})` : "#ffffff";
}
