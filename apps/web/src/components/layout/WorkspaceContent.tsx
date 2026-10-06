import type { ReactNode } from 'react'

export type WorkspaceContentVariant = 'constrained' | 'full'

type WorkspaceContentProps = {
  children: ReactNode
  /**
   * 'constrained' (default): ordinary workspace content (list pages,
   * overview pages). Centered, fluid below the cap.
   * 'full': canvas-like workspaces (e.g. the Project Work Items
   * Kanban board) that deliberately use the entire available
   * main-content width.
   */
  variant?: WorkspaceContentVariant
  className?: string
}

/**
 * Shared workspace content width contract.
 *
 * The AppShell main content area is intentionally NOT max-width
 * constrained: canvas-like views (Kanban boards, future canvas-style
 * workspaces) must remain able to use the full workspace width. The
 * distinction is therefore made explicit per page through this frame:
 *
 * - `constrained` (default): ordinary content is centered at a fluid
 *   width, capped at `--workspace-content-max-width` (defined in
 *   `src/index.css`) on wide desktops. Fluid below the cap; the page's
 *   own responsive padding stays the gutter at narrow widths.
 * - `full`: no width cap — the content spans the available width.
 *
 * The frame owns width/centering only; each page keeps its existing
 * responsive horizontal/vertical padding around it.
 *
 * `data-fg-workspace-content` is the stable semantic marker for the
 * layout contract (tests and tooling key off it, never off the
 * Tailwind class string).
 */
export function WorkspaceContent({
  children,
  variant = 'constrained',
  className,
}: WorkspaceContentProps) {
  const frameClasses =
    variant === 'constrained'
      ? 'mx-auto w-full min-w-0 max-w-[var(--workspace-content-max-width)]'
      : 'w-full min-w-0'

  return (
    <div
      data-fg-workspace-content={variant}
      className={[frameClasses, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
