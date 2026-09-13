/**
 * Shared visual contract for the public auth screens (Login and the
 * new-account Create Account phase): canonical functional tokens only,
 * 4px control radius, 40px controls, no card, no shadow.
 */

export const AUTH_INPUT_BASE_CLASSES = [
  'h-10 w-full rounded border bg-surface-quiet px-3 text-sm leading-5 text-text',
  'transition-colors',
  'hover:border-border-control',
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-1 focus:ring-offset-canvas',
].join(' ')

export const AUTH_INPUT_BORDER_DEFAULT = 'border-border-default'

export const AUTH_INPUT_BORDER_DANGER = 'border-danger'

export const AUTH_FIELD_LABEL_CLASSES =
  'mb-1.5 block text-xs font-medium leading-[18px] text-text-muted'

export const AUTH_FIELD_ERROR_TEXT_CLASSES = 'text-xs leading-4 text-danger'

export const AUTH_FIELD_ERROR_CLASSES =
  `mt-[5px] ${AUTH_FIELD_ERROR_TEXT_CLASSES}`

/**
 * Trailing reservation for password inputs. The 72px band hosts two
 * distinct physical slots that must never overlap:
 *   1. the browser-native credential/reveal control, which browsers
 *      anchor at the far-right edge of the input (~0-32px from the edge),
 *   2. the app's own 32px reveal button (see AUTH_PASSWORD_TOGGLE_CLASSES,
 *      ~32-64px from the edge).
 * The text itself ends 72px short of the edge, so it clears both slots.
 * No attribute or CSS disables password managers or autocomplete — the
 * reservation keeps their functionality intact while removing the
 * collision with the app control.
 */
export const AUTH_PASSWORD_INPUT_TRAILING_CLASSES = 'pr-[72px]'

export const AUTH_PASSWORD_TOGGLE_CLASSES = [
  // 32x32 target, 4px radius. Positioned 32px from the right edge so the
  // far-right band stays free for the browser-native credential/reveal
  // control; the two controls occupy separate trailing slots.
  'absolute right-[32px] top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-text-tertiary transition-colors',
  'hover:bg-surface-hover hover:text-text',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface-quiet',
].join(' ')
