"use client";

import { useEffect, useState } from "react";

/**
 * Wraps page content and adjusts its max-width to match the app sidebar's
 * collapse state.
 *
 * When the sidebar collapses (w-64 → w-14), the main content area becomes
 * 200px wider. If the inner content uses a fixed `max-w-6xl` centered with
 * `mx-auto`, the extra space shows up as larger left/right margins — the
 * content "drifts" inward. This container listens for the sidebar's
 * `sidebar-collapse` custom event (dispatched by the Sidebar component) and
 * widens the max-width by 200px when collapsed, so the visual margins stay
 * consistent across both states.
 *
 * On mount it also reads the persisted value from localStorage so the correct
 * width is applied before the sidebar finishes hydrating.
 */
export function SidebarAwareContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Hydrate from localStorage so the width is correct on first paint
    // after a page navigation (the sidebar's own hydration hasn't fired its
    // event yet).
    try {
      const stored = localStorage.getItem("sidebar:collapsed");
      if (stored === "1") setCollapsed(true);
    } catch {
      // ignore
    }

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ collapsed: boolean }>).detail;
      if (detail && typeof detail.collapsed === "boolean") {
        setCollapsed(detail.collapsed);
      }
    };
    window.addEventListener("sidebar-collapse", handler);
    return () => window.removeEventListener("sidebar-collapse", handler);
  }, []);

  return (
    <div
      className={`mx-auto px-6 ${
        collapsed ? "max-w-[calc(72rem+200px)]" : "max-w-6xl"
      } ${className ?? ""}`}
    >
      {children}
    </div>
  );
}
