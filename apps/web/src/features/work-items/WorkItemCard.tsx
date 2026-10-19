import type { ReactNode } from 'react'

import {
  getWorkItemCardDueState,
  type WorkItemCardStatusCategory,
} from './workItemDue'

/**
 * WorkItemCard — the ONE shared Kanban Work Item card.
 *
 * The Project Work Items Board (features/projects) and the global
 * My Work Kanban (features/my-work) both render their cards through
 * this component, so the card's outer markup and surface style,
 * title typography and one-line ellipsis, spacing/border/hover, the
 * Selected / Focus / Dragging / Pending presentations, the complete
 * exception presentation (Blocked + Due Today / Tomorrow / Overdue /
 * Future — text-only due hints, no warning symbols, no empty footer),
 * the optional metadata regions, and the top-right action-menu
 * position all have exactly one implementation.
 *
 * What stays OUTSIDE the card (in each board's controller):
 *   - data adaptation (ApiWorkItem + Project configuration vs
 *     ApiPersonalWorkItem — the adapters resolve the concrete type
 *     name, the semantic type kind, and the status category from
 *     their own authoritative source; nothing is guessed from a
 *     display name),
 *   - permissions and read-only gating (who gets the action slot),
 *   - selection, drag tracking, pending mutations, and the concrete
 *     reorder/refresh behavior behind drag events.
 *
 * The card itself performs no API requests and no business logic:
 * it only presents the given values and forwards native drag
 * events + the open intent to the calling controller.
 *
 * Design base: the compact My Work board card (min-h-[88px],
 * px-3 py-2.5, work-card surface tokens, 13px/18px title), Light
 * and Dark. Type icons are NOT part of the card contract: the
 * concrete project-local type is rendered as text, semantically
 * colored by the machine-readable type kind (neutral for a null
 * kind, never inferred from the name).
 */

// The stable semantic kind of a Work Item's concrete TypeDefinition
// (system-assigned; `null` = custom / unclassified type). Type-
// specific presentation keys off this ONLY — never off the
// `typeName` display string.
export type WorkItemCardTypeKind =
  | 'task'
  | 'epic'
  | 'milestone'
  | 'deliverable'
  | null

export interface WorkItemCardAssignee {
  id: string
  name: string
  initials: string
}

// Optional provenance line (My Work: Research Group › Project —
// group first). The Project Board passes none: its cards already
// live inside their Project.
export interface WorkItemCardProvenance {
  researchGroupName: string
  projectName: string
}

export interface WorkItemCardProps {
  // Canonical Work Item ID in string form: drives the
  // `data-work-item-id` hook and the native drag payload.
  id: string
  title: string
  // The concrete project-local type NAME (display metadata of the
  // canonical typeDefinitionId), rendered as text.
  typeName: string
  typeKind: WorkItemCardTypeKind
  // Resolved semantic status category of the item's concrete
  // StatusDefinition. `null` = UNRESOLVED: it is never interpreted
  // as `todo` (or `done`) for presentation purposes.
  statusCategory: WorkItemCardStatusCategory
  // Canonical `YYYY-MM-DD` due date (null = none). The card derives
  // its own due presentation state (workItemDue).
  dueDate: string | null
  // `blockedReason` present (non-null) = blocked; the reason is
  // exposed as the native tooltip of the Blocked hint.
  blockedReason: string | null
  // Optional metadata regions: assignee display (Project Board) and
  // provenance breadcrumb (My Work). `undefined` = region absent.
  assignees?: WorkItemCardAssignee[]
  provenance?: WorkItemCardProvenance
  // Presentation states (all optional; defaults = not in that state).
  selected?: boolean
  dragging?: boolean
  // A mutation for this item is in flight: restrained dim +
  // progress cursor, never an optimistic move.
  pending?: boolean
  // The board offers no drag for this card (e.g. read-only project
  // or status resolution not ready): the card stays openable but
  // can never start a drag.
  dragDisabled?: boolean
  // The open intent (click / Enter / Space).
  onOpen: () => void
  // Native drag event forwarding: the card sets the ID payload and
  // effect; the controller tracks the drag and handles the drop.
  onDragStart: () => void
  onDragEnd: () => void
  // Optional structured action slot (the three-dot "Work item
  // actions" menu). Rendered at the top-right corner of the title
  // row, at a position independent of the title length. The card
  // isolates the slot from the card's own behavior: clicking it
  // never opens the drawer and interacting with it never starts a
  // drag.
  actions?: ReactNode
}

// Semantic type-label color, keyed ONLY by the machine-readable
// kind (a null kind stays neutral — a custom type named e.g. "Epic"
// is never presented as an epic).
const TYPE_KIND_LABEL_CLASSES: Record<
  Exclude<WorkItemCardTypeKind, null>,
  string
> = {
  task: 'text-work-type-task',
  epic: 'text-work-type-epic',
  milestone: 'text-work-type-milestone',
  deliverable: 'text-work-type-deliverable',
}

const NEUTRAL_TYPE_LABEL_CLASS = 'text-text-tertiary'

// Shared exception-footer text metrics (10px/15px, medium weight).
const EXCEPTION_TEXT_CLASS =
  'text-[10px] font-medium leading-[15px]'

export function WorkItemCard({
  id,
  title,
  typeName,
  typeKind,
  statusCategory,
  dueDate,
  blockedReason,
  assignees,
  provenance,
  selected = false,
  dragging = false,
  pending = false,
  dragDisabled = false,
  onOpen,
  onDragStart,
  onDragEnd,
  actions,
}: WorkItemCardProps) {
  const dueState = getWorkItemCardDueState(
    dueDate,
    statusCategory,
  )

  // The assignee region is present when the adapter supplies the
  // prop at all — an EMPTY array is still relevant information
  // (the "Unassigned" state); `undefined` means the region does
  // not exist on this board (e.g. My Work).
  const hasAssigneeRegion = assignees != null
  const hasExceptions =
    blockedReason != null || dueState.kind !== 'none'

  // No footer without relevant information: it renders only for
  // assignee metadata or at least one exception.
  const showFooter = hasAssigneeRegion || hasExceptions

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Open ${title}`}
      data-work-item-id={id}
      data-selected={selected ? 'true' : undefined}
      draggable={!dragDisabled}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Only the card ITSELF (role="button") is the keyboard
        // activation target: a keydown bubbling up from a nested
        // interactive element (the three-dot "Work item actions"
        // trigger or its menu) must not open the drawer — that
        // element owns its own keyboard activation.
        if (event.target !== event.currentTarget) {
          return
        }

        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      onDragStart={(event) => {
        if (dragDisabled) {
          return
        }

        event.dataTransfer.setData('text/plain', id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      className={[
        // Shared card surface: 1px SUBTLE rest border, no shadow.
        // The rest border color is explicit (work-card-border): an
        // uncolored `border` falls back to Tailwind's currentColor
        // default and frames the card in the full text color — a
        // near-white outline in Dark. Hover = slightly raised
        // surface + stronger border (border-default wins on :hover),
        // no lift/scale animation, background/border-only ~120ms
        // transition. Keyboard focus gets a real focus outline.
        'min-h-[88px] rounded-md border bg-work-card px-3 py-2.5 transition-[background-color,border-color] duration-120',
        'hover:border-border-default hover:bg-work-card-hover',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        selected
          ? 'outline outline-2 -outline-offset-2 outline-card-selected-ring bg-card-selected-bg shadow-sm'
          : '',
        // Exactly one border-color utility per presentation state:
        // dragging overrides the subtle rest border with the accent;
        // every other state (incl. drag-disabled, a rest card) keeps
        // the work-card-border rest color.
        dragging
          ? 'border-accent opacity-[0.85]'
          : pending
            ? 'cursor-progress border-work-card-border opacity-60'
            : dragDisabled
              ? 'border-work-card-border'
              : 'cursor-grab border-work-card-border active:cursor-grabbing',
      ].join(' ')}
    >
      {/* Title row: one-line ellipsis title + the optional
          top-right action slot (position independent of the
          title length). No type icon: the type is the text label
          below. */}
      <div className="flex min-w-0 items-start gap-2">
        <h3 className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-[18px] text-text">
          {title}
        </h3>

        {actions != null && (
          // The action slot never opens the card drawer and never
          // starts a board drag: the card stops click + pointer
          // propagation and prevents drag start here, so the
          // guarantee lives in ONE place for every consumer.
          <div
            draggable={false}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDragStart={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            className="shrink-0"
          >
            {actions}
          </div>
        )}
      </div>

      {/* The concrete project-local type as text — semantic color
          by machine-readable kind only (neutral for null). */}
      <div
        className={`mt-[3px] truncate text-[10px] font-medium leading-[14px] ${typeKind != null ? TYPE_KIND_LABEL_CLASSES[typeKind] : NEUTRAL_TYPE_LABEL_CLASS}`}
      >
        {typeName}
      </div>

      {provenance != null && (
        // Provenance breadcrumb: Research Group › Project (group
        // first). One line with truncation; the native tooltip
        // carries the complete string.
        <div
          className="mt-2 flex min-w-0 items-center text-[10px] leading-[15px]"
          title={`${provenance.researchGroupName} › ${provenance.projectName}`}
        >
          <span className="min-w-0 truncate text-text-tertiary">
            {provenance.researchGroupName}
          </span>

          <span
            aria-hidden="true"
            className="shrink-0 text-control-disabled-foreground"
          >
            {' › '}
          </span>

          <span className="min-w-0 truncate font-medium text-text-muted">
            {provenance.projectName}
          </span>
        </div>
      )}

      {showFooter && (
        // Exception footer — rendered ONLY when it carries
        // information. Assignee metadata first (where present),
        // then the exception presentation, implemented HERE ONLY:
        // Blocked (icon + warning text, reason as tooltip) and the
        // text-only due state (warning for Today/Tomorrow, danger
        // for Overdue, neutral for future dates).
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-3 border-t border-work-lane-divider pt-[7px]">
          {hasAssigneeRegion && (
            <WorkItemAssignees assignees={assignees!} />
          )}

          {blockedReason != null && (
            <span
              title={blockedReason}
              className={`flex items-center gap-1 ${EXCEPTION_TEXT_CLASS} text-work-exception-warning`}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[13px]"
              >
                block
              </span>
              Blocked
            </span>
          )}

          {dueState.kind === 'overdue' && (
            <span
              className={`${EXCEPTION_TEXT_CLASS} text-work-exception-danger`}
            >
              {dueState.label}
            </span>
          )}

          {dueState.kind === 'today' && (
            <span
              className={`${EXCEPTION_TEXT_CLASS} text-work-exception-warning`}
            >
              Due today
            </span>
          )}

          {dueState.kind === 'tomorrow' && (
            <span
              className={`${EXCEPTION_TEXT_CLASS} text-work-exception-warning`}
            >
              Tomorrow
            </span>
          )}

          {dueState.kind === 'future' && (
            <span
              className={`${EXCEPTION_TEXT_CLASS} text-text-muted`}
            >
              {dueState.label}
            </span>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * Assignee presentation used by the shared card footer and the
 * Project Work Items List row: up to two initial avatars + the
 * first assignee's name with an `+N` overflow count, or the quiet
 * "Unassigned" state. Pure display — no lookup, no requests.
 */
export function WorkItemAssignees({
  assignees,
}: {
  assignees: WorkItemCardAssignee[]
}) {
  if (assignees.length === 0) {
    return (
      <span className="text-xs font-normal text-work-content-muted">
        Unassigned
      </span>
    )
  }

  const visibleAssignees = assignees.slice(0, 2)
  const additionalCount = assignees.length - 1

  return (
    <div
      className="flex min-w-0 items-center gap-2"
      title={assignees.map((assignee) => assignee.name).join(', ')}
    >
      <div className="flex shrink-0 -space-x-1.5">
        {visibleAssignees.map((assignee) => (
          <div
            key={assignee.id}
            className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-surface bg-work-surface-support text-[8px] font-semibold text-work-content-text"
          >
            {assignee.initials}
          </div>
        ))}
      </div>

      <span className="truncate text-xs font-normal text-work-content-muted">
        {assignees[0].name}
        {additionalCount > 0 ? ` +${additionalCount}` : ''}
      </span>
    </div>
  )
}
