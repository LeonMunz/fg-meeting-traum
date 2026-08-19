import {
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  EditorContent,
  useEditor,
  useEditorState,
} from '@tiptap/react'

import { createMarkdownExtensions } from './markdownExtensions'
import { EditorBottomToolbar, EditorBubbleToolbar } from './EditorToolbar'

export type MarkdownEditorVariant = 'full' | 'compact'

export type RichMarkdownEditorProps = {
  /** Canonical Markdown — the only shape this component's API ever
   * exposes to callers. Tiptap's document JSON never leaves this
   * component (see markdownExtensions.ts). */
  value: string
  /** Fires on every local edit (not persisted yet). */
  onChange?: (markdown: string) => void
  /** Fires when the editor loses focus with a genuine change to commit —
   * never fires after Escape (see onEscape). */
  onCommit?: (markdown: string) => void
  /** Escape was pressed — the editor blurs itself without committing;
   * the caller decides what "cancel" means (e.g. leave edit mode). */
  onEscape?: () => void
  readOnly?: boolean
  variant?: MarkdownEditorVariant
  /** Empty-state placeholder shown inside the editable surface only —
   * the read-only empty state is handled by the caller (kept lightweight
   * per PHASE 1 SCOPE, never mounts this component at all). */
  placeholder?: string
  autoFocus?: boolean
  ariaLabel?: string
  className?: string
}

/**
 * Reusable Markdown-as-rich-text editor foundation. One instance is used
 * for BOTH the read display (readOnly, no toolbar/menus) and the active
 * editing surface (toolbar + BubbleMenu) — the product model is "the
 * same surface becomes an editor," not two different renderers, so
 * toggling `readOnly` is the only thing that changes between the two.
 *
 * Phase 1: wired up for Work Item Description (`variant="full"`) only.
 * `variant="compact"` is accepted so a future compact variant (Comments,
 * Blocked reason) can reuse this component without a new API — it is
 * not exercised yet, so it currently just suppresses the toolbar/menus.
 */
export function RichMarkdownEditor({
  value,
  onChange,
  onCommit,
  onEscape,
  readOnly = false,
  variant = 'full',
  placeholder,
  autoFocus = false,
  ariaLabel,
  className,
}: RichMarkdownEditorProps) {
  const suppressNextBlurCommitRef = useRef(false)
  const hasAutoFocusedRef = useRef(false)

  // Lifted (rather than owned by EditorToolbar) so the BubbleMenu's Link
  // button, the bottom toolbar's Link button, and Cmd/Ctrl+K all open
  // the exact same popover instance instead of three independent ones.
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false)

  // `editorProps.handleKeyDown` below is only recreated when [readOnly,
  // variant] change (see the useEditor deps array) — a stable ref (never
  // stale, unlike the `linkPopoverOpen` state value a closure from an
  // earlier render would otherwise capture) is what lets it always read
  // the CURRENT open/closed state of the popover.
  const linkPopoverOpenRef = useRef(linkPopoverOpen)
  linkPopoverOpenRef.current = linkPopoverOpen

  // Same staleness hazard as linkPopoverOpenRef above, for the callback
  // props: `editorProps`/`onUpdate`/`onBlur` are only rebuilt when
  // [readOnly, variant] change, so a directly-closed-over `onCommit`
  // etc. could be an old render's version if the parent passes a new
  // function identity on every render (WorkItemDrawer does). Refs kept
  // fresh on every render sidestep that entirely.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  const editor = useEditor(
    {
      editable: !readOnly,
      content: value,
      // @tiptap/markdown's contentType flag — see markdownExtensions.ts.
      contentType: 'markdown',
      extensions: createMarkdownExtensions({ placeholder }),
      editorProps: {
        attributes: {
          class: [
            'fg-prose',
            variant === 'compact' ? 'fg-prose--compact' : '',
          ]
            .filter(Boolean)
            .join(' '),
          ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        },
        handleKeyDown: (view, event) => {
          if (event.key === 'Escape') {
            if (linkPopoverOpenRef.current) {
              setLinkPopoverOpen(false)
              return true
            }

            suppressNextBlurCommitRef.current = true
            onEscapeRef.current?.()
            view.dom.blur()
            return true
          }

          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === 'k'
          ) {
            event.preventDefault()

            // Adding a link needs a selection to attach it to — this
            // mirrors the toolbar Link button's own `canLink` check.
            // (Editing an already-collapsed cursor's link is still
            // reachable via the toolbar/BubbleMenu Link button, which
            // has access to the live `editor` instance and its
            // `isActive('link')` state; this handler intentionally
            // doesn't reference the outer `editor` closure, which would
            // itself be stale for the same reason `linkPopoverOpen`
            // was.)
            if (!view.state.selection.empty) {
              setLinkPopoverOpen(true)
            }

            return true
          }

          return false
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        onChangeRef.current?.(currentEditor.getMarkdown())
      },
      onBlur: ({ editor: currentEditor }) => {
        if (suppressNextBlurCommitRef.current) {
          suppressNextBlurCommitRef.current = false
          return
        }

        onCommitRef.current?.(currentEditor.getMarkdown())
      },
    },
    // Recreated only when switching between read/edit or variant — the
    // `value` sync effect below (not this dependency array) is what
    // handles ordinary content updates, so typing never remounts.
    [readOnly, variant],
  )

  // Keep the editor's document in sync with an externally-changed
  // `value` (e.g. switching Work Items, or a value passed in fresh after
  // this component remounted readOnly) — but never while the user is
  // actively focused in it, which would clobber an in-progress edit.
  useEffect(() => {
    if (!editor) {
      return
    }

    if (editor.isFocused) {
      return
    }

    if (editor.getMarkdown() === value) {
      return
    }

    editor.commands.setContent(value, {
      contentType: 'markdown',
      emitUpdate: false,
    })
  }, [editor, value])

  useEffect(() => {
    if (!editor || !autoFocus || hasAutoFocusedRef.current) {
      return
    }

    hasAutoFocusedRef.current = true
    editor.commands.focus('end')
  }, [editor, autoFocus])

  // The toolbar/BubbleMenu buttons read `editor.isActive(...)` directly
  // during render rather than through a prop-drilled selector result —
  // cheap enough for one active editor — but that only means THIS
  // component must re-render whenever the active formatting state could
  // have changed. `useEditorState` (rather than e.g. a naive
  // `editor.on('transaction', forceUpdate)`) is what makes that safe:
  // it only triggers a re-render when the SELECTED value actually
  // changes, so it can't runaway-loop even if something else (e.g. the
  // BubbleMenu plugin's own internal position bookkeeping) dispatches
  // transactions that don't affect any of these.
  useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => {
      if (!currentEditor) {
        return null
      }

      return {
        bold: currentEditor.isActive('bold'),
        italic: currentEditor.isActive('italic'),
        code: currentEditor.isActive('code'),
        link: currentEditor.isActive('link'),
        bulletList: currentEditor.isActive('bulletList'),
        orderedList: currentEditor.isActive('orderedList'),
        taskList: currentEditor.isActive('taskList'),
        blockquote: currentEditor.isActive('blockquote'),
        heading2: currentEditor.isActive('heading', {
          level: 2,
        }),
        heading3: currentEditor.isActive('heading', {
          level: 3,
        }),
        canLink:
          !currentEditor.state.selection.empty ||
          currentEditor.isActive('link'),
        selectionEmpty: currentEditor.state.selection.empty,
      }
    },
  })

  if (!editor) {
    return null
  }

  const linkPopover = {
    open: linkPopoverOpen,
    onOpen: () => setLinkPopoverOpen(true),
    onClose: () => setLinkPopoverOpen(false),
  }

  return (
    <div className={className}>
      <EditorContent editor={editor} />

      {!readOnly && variant === 'full' && (
        <>
          <EditorBubbleToolbar
            editor={editor}
            linkPopover={linkPopover}
          />
          <EditorBottomToolbar
            editor={editor}
            linkPopover={linkPopover}
          />
        </>
      )}
    </div>
  )
}
