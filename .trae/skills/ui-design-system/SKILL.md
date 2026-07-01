---
name: "ui-design-system"
description: "Analyzes a project's UI design system and produces a reusable style guide, or applies that guide to keep new UI code consistent. Invoke when the user asks to 'analyze UI', 'document the design system', 'write a UI style guide/skill', create new pages/components that should match existing visual language, or audit UI consistency."
---

# UI Design System

A framework-agnostic methodology for **analyzing**, **documenting**, and **applying** a project's UI design system so any new page, component, or modification stays consistent with the established visual language. Works across React, Vue, Next.js, Svelte, plain HTML/CSS, and any styling solution (Tailwind, CSS-in-JS, plain CSS, Sass, etc.).

## When to Use

Invoke this skill when the user asks to:

- "分析这个项目的 UI" / "analyze the UI of this project"
- "把 UI 风格写成一个 skill" / "document the design system as a skill"
- "创建一个 UI 设计规范文档" / "write a UI style guide"
- "新页面/组件要保持风格统一" / "keep new UI consistent with the existing style"
- "审计 UI 一致性" / "audit UI consistency"
- Build or modify UI in a project that already has an established visual language

**Do not invoke** for greenfield projects with no existing UI, or for questions unrelated to visual/styling consistency.

## Workflow

### Phase 1 — Analyze (read before writing)

Use the search subagent or direct reads to gather these dimensions from the **existing** codebase. **Never assume** — always cite real files.

1. **Tech stack**
   - Framework + version (Next.js / Vue / Svelte / plain React / etc.)
   - Styling solution (Tailwind v3/v4, CSS-in-JS, Sass, CSS modules, plain CSS)
   - Component library (shadcn/ui, MUI, Ant Design, Chakra, custom, none)
   - Icon library (lucide, heroicons, phosphor, etc.)
   - Font loading strategy (`next/font`, `@fontsource`, `<link>`, self-hosted)
   - Theming approach (next-themes, CSS variables, data-attributes, none)
   - i18n approach (next-intl, vue-i18n, custom, none)

2. **Design tokens** — locate the single source of truth
   - Color tokens (CSS variables, theme object, Tailwind config, design tokens JSON)
   - Color space (sRGB hex, HSL, OKLCH, Lab)
   - Dark/light mode strategy (class, data-attribute, media-query, none)
   - Spacing scale, radius scale, font-size scale, font-weight scale
   - Shadow tokens, blur tokens, motion easing tokens
   - Typography (font families, where each is used)

3. **Component conventions**
   - List all UI primitives (button, card, input, dialog, etc.)
   - For each, note: variants, sizes, key classes/styles, micro-interactions
   - Identify the variant system (CVA, cva, props-driven, CSS classes)
   - Class merge helper (`cn()`, `clsx`, `classnames`, etc.)

4. **Layout patterns**
   - Root layout structure (where fonts attach, where providers wrap)
   - Navigation pattern (sticky header, sidebar, bottom nav)
   - Standard page shell (container width, padding, header block)
   - Empty/loading/error state patterns
   - Footer handling (global vs per-page vs none)

5. **Theme system**
   - How dark mode is applied (`.dark` class, `[data-theme]`, media query)
   - Toggle implementation (icon swap, system preference, persistence)
   - Any theme-specific exceptions (e.g. export components with hardcoded colors)

6. **Domain-specific UI patterns**
   - Signature interactions (the app's "centerpiece" — e.g. a comparison view, a card grid, a wizard)
   - Recurring surface patterns (frosted navbars, elevated cards, overlay scrims)
   - Animation vocabulary (keyframes, easings, durations used repeatedly)
   - Image/asset handling (fallbacks, proxies, lazy loading, aspect ratios)

7. **Unique design decisions**
   - Collect 8–15 "signature" choices that define the project's identity
   - These become the rules future code must follow

### Phase 2 — Document (write the style guide)

Produce a style guide with this structure. Adapt section names to the project — don't force sections that don't apply.

```markdown
# <Project> UI Style Guide

## Tech Stack
- Framework: ...
- Styling: ...
- Component library: ...
- Icons: ...
- Fonts: ...
- Theming: ...
- i18n: ...

## Design Tokens
### Color System
- Light mode tokens (with exact values)
- Dark mode tokens (with exact values)
- Rules for using semantic utilities vs raw values
### Radius
### Typography (font families + per-use conventions)
### Spacing / Shadow / Motion (if applicable)

## Styling Setup
- Config files (tailwind.config, postcss.config, theme.ts, etc.)
- CSS variable bridge (e.g. `@theme inline`, `:root` mappings)
- Base layer conventions
- Custom utilities & animations

## Component Conventions
For each primitive:
- File path
- Variants & sizes
- Key classes / styles
- Notable micro-interactions

## Layout Patterns
- Root layout
- Providers
- Navigation (with the recurring surface pattern if any)
- Standard page shell (with code sample)
- Empty / loading / error states

## Theme System
- Toggle implementation
- Dark mode rules
- Any exceptions

## Internationalization (if applicable)
- Approach
- How to add new strings
- Hydration/mount gate rules

## Domain-Specific UI Patterns
- Signature interactions
- Recurring surfaces
- Animation vocabulary
- Asset handling

## Summary — Signature Design Decisions
A numbered list of 8–15 rules that define the project's identity.

## When Generating New UI Code
A numbered checklist of 10–15 concrete rules a developer/agent must follow.

## Key File Reference
Clickable file:// links to every file cited above.
```

### Phase 3 — Apply (when generating new UI code)

When the user asks to create or modify UI, follow the "When Generating New UI Code" checklist from the documented guide. Concretely:

1. **Read existing primitives first** — never rewrite a component that already exists.
2. **Use the project's class merge helper** (`cn()` / `clsx` / etc.) — never string-concat classes.
3. **Use semantic design tokens** (`bg-background`, `text-foreground`, etc.) — never raw hex/rgb unless the documented exception applies.
4. **Match the page shell** — same container width, padding, header block structure.
5. **Respect typographic conventions** — if headings use `font-medium`, don't use `font-bold`.
6. **Honor tap target rules** — if the project enforces 44px mobile tap targets, do the same.
7. **Use the project's icon library** at its default size unless overridden.
8. **Add user-facing strings to all locales** the project supports.
9. **Gate on `mounted`/`onMounted`/`useIsClient`** when reading client-only state to avoid hydration mismatch.
10. **Reuse existing image/asset components** rather than re-implementing fallback logic.
11. **Reuse recurring surface patterns** (frosted glass, half-opacity borders, etc.) instead of inventing new ones.
12. **Use the project's tinted destructive variant** (if any) rather than solid red.
13. **Reuse existing animations and easings** rather than inventing new motion.

## Analysis Dimensions (cheat sheet)

When analyzing, cover at minimum:

| Dimension | What to find |
|---|---|
| Color | Tokens, color space, dark mode strategy, semantic vs raw usage |
| Radius | Base value + scale, which radius for which component |
| Typography | Font families, per-use rules, heading weight, display numerals |
| Spacing | Scale, container widths, page padding |
| Motion | Keyframes, easings, durations, where applied |
| Surface | Recurring bg/blur/border patterns (navbar, dialogs, cards) |
| Borders | Solid vs translucent, full vs half opacity, ring vs border |
| Interactions | Hover/active/focus states, press micro-interactions, keyboard support |
| Accessibility | Tap targets, focus rings, sr-only labels, reduced motion |
| Variants | CVA / props system, how variants compose |
| Layout | Root layout, providers, nav, page shell, empty states |
| Theme | Toggle, persistence, system preference, exceptions |
| i18n | Library vs custom, mount gate, interpolation, locale list |
| Assets | Image components, fallbacks, proxies, aspect ratios |
| Domain | The signature interaction(s) unique to this app |

## Output Rules

- **Always cite real files** with clickable `file:///` links. Never reference "line 56 of some file" without a link.
- **Include exact values** (token values, class names, code snippets) — not vague descriptions.
- **Code samples must be real** from the codebase, not invented.
- **Note exceptions** explicitly (e.g. "share-card uses hardcoded hex because `html-to-image` can't read CSS variables").
- **Keep it actionable** — every rule in "When Generating New UI Code" must be something that can be checked.
- **Adapt to the stack** — don't force Tailwind sections on a CSS-in-JS project, don't force shadcn sections on a MUI project.
- **Language**: write the guide in the same language as the user's latest message (zh ↔ en). Code samples stay in their original language.

## Common Pitfalls to Avoid

- Inventing tokens that don't exist in the codebase
- Copying shadcn defaults verbatim without checking the project's customizations
- Forgetting dark mode variants
- Missing the project's signature animation/easing
- Documenting a "standard pattern" that the project actually diverges from
- Ignoring i18n string requirements
- Overlooking accessibility patterns (tap targets, focus rings, sr-only)
- Hardcoding values when the project uses semantic tokens
