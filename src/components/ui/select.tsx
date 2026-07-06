"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Custom dropdown select — replaces native <select> for full style control.
 *
 * Renders a button trigger + absolutely-positioned popover list. The popover
 * auto-positions itself above or below the trigger based on available
 * viewport space, so it never overflows the screen edge.
 *
 * Closes on outside click, Escape key, or option selection. Supports
 * keyboard nav (ArrowUp/Down, Enter, Escape).
 *
 * API:
 *   - `options: SelectOption[]` replaces `<option>` children
 *   - `onChange(value: string)` returns the value directly (not an event)
 */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  /** Render the trigger as a pill (capsule) shape. Used by the chat composer. */
  variant?: "default" | "pill";
  /** Optional placeholder shown when value is empty. */
  placeholder?: string;
}

const POPOVER_MAX_HEIGHT = 240; // px, matches max-h-60 (15rem)
const POPOVER_GAP = 4; // px between trigger and popover

export function Select({
  id,
  value,
  onChange,
  options,
  disabled,
  className,
  variant = "default",
  placeholder,
}: SelectProps) {
  const [open, setOpen] = React.useState(false);
  const t = useTranslations("Common");
  const [highlightedIdx, setHighlightedIdx] = React.useState(-1);
  // "below" renders the popover under the trigger; "above" renders it over
  // the trigger when there isn't enough space below.
  const [placement, setPlacement] = React.useState<"below" | "above">("below");
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  // Recompute placement every time the popover opens (or the viewport
  // resizes while open). We measure the trigger's distance to the bottom
  // and top of the viewport and pick the side with more room.
  const computePlacement = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Need room for the popover height + gap. Prefer "below" on a tie so
    // the default reading direction feels natural.
    const fitsBelow = spaceBelow >= POPOVER_MAX_HEIGHT + POPOVER_GAP;
    const fitsAbove = spaceAbove >= POPOVER_MAX_HEIGHT + POPOVER_GAP;
    if (fitsBelow) {
      setPlacement("below");
    } else if (fitsAbove) {
      setPlacement("above");
    } else {
      // Neither side fits fully — pick whichever has more space and let
      // the popover scroll internally.
      setPlacement(spaceBelow >= spaceAbove ? "below" : "above");
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    computePlacement();
    // Recompute on resize / scroll while open.
    window.addEventListener("resize", computePlacement);
    window.addEventListener("scroll", computePlacement, true);
    return () => {
      window.removeEventListener("resize", computePlacement);
      window.removeEventListener("scroll", computePlacement, true);
    };
  }, [open, computePlacement]);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Reset highlight when opening
  React.useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlightedIdx(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  // Scroll highlighted option into view
  React.useEffect(() => {
    if (!open || highlightedIdx < 0) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.children[highlightedIdx] as HTMLElement | undefined;
    if (item) {
      item.scrollIntoView({ block: "nearest" });
    }
  }, [open, highlightedIdx]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIdx((prev) => {
          let next = prev + 1;
          while (next < options.length && options[next].disabled) next++;
          return next < options.length ? next : prev;
        });
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIdx((prev) => {
          let next = prev - 1;
          while (next >= 0 && options[next].disabled) next--;
          return next >= 0 ? next : prev;
        });
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedIdx >= 0 && !options[highlightedIdx].disabled) {
          onChange(options[highlightedIdx].value);
          setOpen(false);
          triggerRef.current?.focus();
        }
        break;
    }
  }

  const isPill = variant === "pill";

  return (
    <div ref={containerRef} className={cn("relative", isPill && "inline-flex items-end", className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        title={selected ? selected.label : undefined}
        className={cn(
          "flex items-center justify-between gap-1.5 text-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          isPill
            ? "h-8 max-w-[120px] shrink-0 rounded-full border border-border bg-muted/50 px-3 font-medium text-foreground hover:bg-muted"
            : "h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-foreground hover:border-primary/50",
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected ? selected.label : (placeholder ?? t("selectDefault"))}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          style={{
            maxHeight: POPOVER_MAX_HEIGHT,
            // Position the popover absolutely. When "above", anchor it to the
            // top of the trigger (popover grows upward via bottom-anchoring).
            // We use inline styles for the dynamic offset; Tailwind classes
            // handle the visual styling.
            ...(placement === "above"
              ? { bottom: `calc(100% + ${POPOVER_GAP}px)` }
              : { top: `calc(100% + ${POPOVER_GAP}px)` }),
          }}
          className="absolute left-0 z-50 w-full min-w-[200px] overflow-auto rounded-md border border-border bg-white p-1 shadow-lg"
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isHighlighted = idx === highlightedIdx;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                title={opt.label}
                onClick={() => {
                  if (opt.disabled) return;
                  onChange(opt.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                onMouseEnter={() => !opt.disabled && setHighlightedIdx(idx)}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors",
                  isHighlighted && !opt.disabled && "bg-accent",
                  isSelected && "font-medium",
                  opt.disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <Check
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-primary",
                    isSelected ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="truncate">{opt.label}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
