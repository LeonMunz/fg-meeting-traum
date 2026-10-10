import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import type {
  KeyboardEvent,
  MouseEvent,
} from 'react'

import { ApiError } from '../../api/client'
import { RichMarkdownEditor } from '../../components/editor/RichMarkdownEditor'

/**
 * Unified topic Markdown surfaces for the meeting preparation view.
 *
 * Product model: one canonical Markdown `content` field per topic.
 * The DISPLAY is the established Markdown renderer (RichMarkdownEditor
 * in read-only mode — the same surface and styling conventions the
 * Work Item Description uses); the EDITING surface is a deliberately
 * minimal multiline text editor that holds the Markdown source
 * VERBATIM. The verbatim composer (rather than the Tiptap editor) is
 * what guarantees a save sends exactly the canonical source the user
 * saw — no serializer normalization, no formatting loss — while the
 * read-only renderer provides the established visual conventions.
 *
 * There is no title / notes form, no toolbar, no preview mode, and
 * no truncation: the entire document is always visible, and the
 * rendered document itself is the editing entry point.
 */

// ── Display ──────────────────────────────────────────────────────

/**
 * Renders the topic's canonical Markdown content in full (no
 * truncation, clamping, or internal scrolling). When `onEdit` is
 * provided the rendered content itself is the editing entry point:
 * pointer activation (except on interactive links, which stay
 * operable) and keyboard activation (Enter / Space) both open the
 * editor in place.
 */
export function TopicMarkdownDisplay({
  content,
  onEdit,
  editLabel,
}: {
  content: string
  onEdit?: () => void
  editLabel?: string
}) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (onEdit == null) {
      return
    }

    // Interactive links inside the rendered Markdown remain
    // operable: a click that lands on (or inside) a link never
    // activates editing.
    if (
      event.target instanceof HTMLElement &&
      event.target.closest('a') != null
    ) {
      return
    }

    onEdit()
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (onEdit == null) {
      return
    }

    if (
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      // The container itself is the activation control; keep Space
      // from scrolling the page and Enter from double-activating
      // (the native click emulation for role=button would not fire
      // for Enter in a focusable div, so this handler owns it).
      event.preventDefault()
      onEdit()
    }
  }

  return (
    <div
      role={onEdit != null ? 'button' : undefined}
      tabIndex={onEdit != null ? 0 : undefined}
      aria-label={onEdit != null ? editLabel : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={
        onEdit != null
          ? 'cursor-text rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[#6898F0] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1A1A1A]'
          : undefined
      }
    >
      <RichMarkdownEditor
        value={content}
        readOnly={true}
        variant="full"
      />
    </div>
  )
}

// ── Composer (creation + editing) ────────────────────────────────

/**
 * The minimal Markdown editing surface: one multiline field holding
 * the canonical source verbatim, plus restrained Save / Cancel.
 *
 * - Enter inserts a newline (native textarea behavior).
 * - Cmd/Ctrl+Enter saves; Escape cancels (discards the draft).
 * - Tab keeps normal focus navigation (no indent binding).
 * - The field auto-expands with its content: no internal scrolling,
 *   no maximum height, comfortable minimum height, autofocus.
 * - Whitespace-only content is never submitted.
 * - A rejected save keeps the draft open and shows the error
 *   unobtrusively inline; the in-flight state prevents duplicates.
 */
export function TopicMarkdownComposer({
  initialValue,
  onSave,
  onCancel,
  saving = false,
  ariaLabel,
  placeholder = 'Add a topic…',
}: {
  initialValue: string
  onSave: (content: string) => Promise<void>
  onCancel: () => void
  saving?: boolean
  ariaLabel: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState(initialValue)
  const [error, setError] = useState<
    string | null
  >(null)
  const textareaRef = useRef<
    HTMLTextAreaElement
  >(null)
  const submitInFlightRef = useRef(false)

  // Autofocus: the surface is immediately typeable.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Auto-expand: the field grows with the content (no internal
  // scrolling, no max height).
  useLayoutEffect(() => {
    const el = textareaRef.current

    if (el == null) {
      return
    }

    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  const submit = async () => {
    // Duplicate-submission guard: while a save is in flight (the
    // `saving` prop or a locally in-flight submit) nothing else
    // goes out.
    if (saving || submitInFlightRef.current) {
      return
    }

    // Whitespace-only content is never submitted (the server
    // rejects it too; this keeps the error unobtrusive and local).
    if (draft.trim() === '') {
      setError('Topic content must not be empty.')

      return
    }

    submitInFlightRef.current = true
    setError(null)

    try {
      // The ENTIRE draft is the canonical content — sent
      // verbatim (no client-side trimming that would alter the
      // stored Markdown source).
      await onSave(draft)
    } catch (submitError) {
      // Preserve the draft after a failed save; surface the
      // server's message (or a calm fallback) inline.
      setError(
        composerErrorText(submitError),
      )
    } finally {
      submitInFlightRef.current = false
    }
  }

  const handleKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      // The composer owns Escape: cancel without letting the
      // event bubble to outer page-level Escape handlers.
      event.stopPropagation()

      if (!saving) {
        onCancel()
      }

      return
    }

    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === 'Enter'
    ) {
      event.preventDefault()
      void submit()
    }
    // Plain Enter falls through: the textarea inserts a newline.
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      className="overflow-hidden rounded-lg border border-white/[0.08] bg-[#222222]"
    >
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)

          if (error != null) {
            setError(null)
          }
        }}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
        aria-invalid={
          error != null
            ? true
            : undefined
        }
        placeholder={placeholder}
        rows={4}
        className="block max-w-full min-h-[132px] w-full resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent px-3 py-2.5 text-[15px] leading-[22px] text-[#E6E6E6] outline-none placeholder:text-[#8A8A8A]"
      />

      {error != null && (
        <p
          role="alert"
          className="border-t border-white/[0.06] px-3 pb-1 pt-2 text-[13px] leading-[18px] text-danger"
        >
          {error}
        </p>
      )}

      <div className="flex items-center gap-2 border-t border-white/[0.06] px-2 py-1.5">
        <button
          type="submit"
          disabled={
            saving ||
            draft.trim() === ''
          }
          className="h-7 shrink-0 rounded px-2 text-[13px] font-medium text-[#E6E6E6] outline-none transition hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-[#6898F0] disabled:opacity-45"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>

        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="h-7 shrink-0 rounded px-2 text-[13px] font-medium text-[#A3A3A3] outline-none transition hover:bg-white/[0.06] hover:text-[#E6E6E6] focus-visible:ring-2 focus-visible:ring-[#6898F0] disabled:opacity-45"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Error text ───────────────────────────────────────────────────

/**
 * Unobtrusive, human-readable save error: the server's message when
 * it carries one (the canonical `{ error }` envelope or a DRF field
 * validation list), otherwise a calm fallback.
 */
function composerErrorText(
  error: unknown,
): string {
  if (
    error instanceof ApiError &&
    error.detail != null &&
    typeof error.detail === 'object'
  ) {
    const detail = error.detail as Record<
      string,
      unknown
    >

    if (typeof detail.error === 'string') {
      return detail.error
    }

    const first = Object.values(detail)[0]

    if (Array.isArray(first) && first.length > 0) {
      const entry = first[0]

      if (typeof entry === 'string') {
        return entry
      }
    } else if (typeof first === 'string') {
      return first
    }
  }

  return 'Topic could not be saved.'
}
