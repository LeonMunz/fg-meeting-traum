/**
 * Shared Work Item due-date presentation helpers.
 *
 * The Project Work Items Board and the global My Work Kanban render
 * due dates through the SAME shared board card
 * (features/work-items/WorkItemCard), and every other Work Item
 * surface (List views, projections) needs the same single date
 * interpretation. Keeping `getWorkItemDueFields` here — instead of
 * each page carrying a private copy — makes the card's due state the
 * only due-date presentation in the repository.
 *
 * These are PURE presentation helpers over the canonical `dueDate`
 * value: no business rules, no requests.
 */

// The four fixed semantic status categories of a Work Item's concrete
// StatusDefinition — plus `null` for an UNRESOLVED category (missing
// configuration, an unknown ID, or a category outside the fixed set).
// `null` must never be folded into a guessed category (e.g. `todo`),
// and it is never interpreted as `done`.
export type WorkItemCardStatusCategory =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'done'
  | null

/**
 * Due state of a Work Item for the shared board card's exception
 * footer:
 *   - `none`     → render nothing (no due date, or a completed item);
 *   - `future`   → neutral short-date metadata;
 *   - `today`    → explicit warning text ("Due today");
 *   - `tomorrow` → explicit warning text ("Tomorrow");
 *   - `overdue`  → explicit danger text ("Nd overdue").
 *
 * The due state is text-only (no warning icon); the written label
 * carries the meaning, so color is never the sole carrier.
 */
export type WorkItemCardDueState =
  | { kind: 'none' }
  | { kind: 'future'; label: string }
  | { kind: 'today' }
  | { kind: 'tomorrow' }
  | { kind: 'overdue'; label: string }

/**
 * Parse a canonical `YYYY-MM-DD` due date into its relative distance
 * from local today plus the established short label ("Today" /
 * "Tomorrow" / "Mon 12"-style compact date). An absent or
 * structurally invalid date yields all-null fields (nothing to show).
 */
export function getWorkItemDueFields(
  dueDate: string | null,
): {
  dueInDays: number | null
  dueLabel: string | null
} {
  if (!dueDate) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const [year, month, day] =
    dueDate.split('-').map(Number)

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    return {
      dueInDays: null,
      dueLabel: null,
    }
  }

  const targetDate = new Date(
    year,
    month - 1,
    day,
  )

  const now = new Date()

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )

  const dueInDays = Math.round(
    (targetDate.getTime() -
      today.getTime()) /
      86_400_000,
  )

  const dueLabel =
    dueInDays === 0
      ? 'Today'
      : dueInDays === 1
        ? 'Tomorrow'
        : new Intl.DateTimeFormat('en', {
            month: 'short',
            day: 'numeric',
          }).format(targetDate)

  return {
    dueInDays,
    dueLabel,
  }
}

/**
 * Resolve the shared board card's due presentation state from the
 * canonical due date and the item's resolved semantic status
 * category. Only the explicit `done` category suppresses the due
 * hint (a completed item carries no due exception); an UNRESOLVED
 * (`null`) category is never treated as `done` or any other
 * category — it simply receives the ordinary due presentation.
 */
export function getWorkItemCardDueState(
  dueDate: string | null,
  statusCategory: WorkItemCardStatusCategory,
): WorkItemCardDueState {
  if (statusCategory === 'done') {
    return { kind: 'none' }
  }

  const due = getWorkItemDueFields(dueDate)

  if (due.dueInDays == null) {
    return { kind: 'none' }
  }

  if (due.dueInDays < 0) {
    return {
      kind: 'overdue',
      label: `${Math.abs(due.dueInDays)}d overdue`,
    }
  }

  if (due.dueInDays === 0) {
    return { kind: 'today' }
  }

  if (due.dueInDays === 1) {
    return { kind: 'tomorrow' }
  }

  return {
    kind: 'future',
    label: due.dueLabel ?? '',
  }
}
