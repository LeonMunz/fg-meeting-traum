import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'

/**
 * Small app-styled popover for adding/updating/removing a link — used
 * instead of `prompt()` from both the bottom toolbar and the BubbleMenu
 * (see EditorToolbar.tsx), and from the Cmd/Ctrl+K shortcut.
 *
 * Deliberately simple: one URL field, Apply/Remove/Cancel. No target
 * picker, no title field — matches the conservative Markdown subset
 * (a link is just `[text](href)`).
 */
export function LinkPopover({
  editor,
  onClose,
}: {
  editor: Editor
  onClose: () => void
}) {
  const existingHref =
    (editor.getAttributes('link').href as string | undefined) ?? ''

  const [href, setHref] = useState(existingHref)
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }

    // Capture phase so a click that also lands on the editor (e.g.
    // clicking elsewhere in the Description to move the cursor) closes
    // the popover before that click's own handling runs.
    document.addEventListener(
      'mousedown',
      handleClickOutside,
      true,
    )

    return () =>
      document.removeEventListener(
        'mousedown',
        handleClickOutside,
        true,
      )
  }, [onClose])

  function applyLink() {
    const trimmed = href.trim()

    if (!trimmed) {
      editor.chain().focus().unsetLink().run()
      onClose()
      return
    }

    const url =
      /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
      trimmed.startsWith('mailto:')
        ? trimmed
        : `https://${trimmed}`

    editor
      .chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: url })
      .run()
    onClose()
  }

  function removeLink() {
    editor.chain().focus().unsetLink().run()
    onClose()
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Edit link"
      className="absolute bottom-full left-0 z-10 mb-2 w-72 rounded-lg border border-border-default bg-surface p-2.5 shadow-lg shadow-color"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          editor.chain().focus().run()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          applyLink()
        }
      }}
    >
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-control-foreground">
          Link URL
        </span>

        <input
          ref={inputRef}
          type="text"
          value={href}
          onChange={(event) => setHref(event.target.value)}
          placeholder="https://…"
          className="h-8 w-full rounded-md border border-editor-boundary bg-surface px-2.5 text-sm text-text-primary placeholder:text-text-work-faded-55 outline-none focus:border-focus-ring-primary focus:ring-2 focus:ring-focus-ring-primary/15"
        />
      </label>

      <div className="mt-2 flex items-center justify-end gap-2">
        {existingHref && (
          <button
            type="button"
            onClick={removeLink}
            className="h-7 rounded-md px-2 text-xs font-medium text-work-item-error transition hover:bg-work-item-error-bg/60"
          >
            Remove
          </button>
        )}

        <button
          type="button"
          onClick={applyLink}
          className="h-7 rounded-md bg-action px-3 text-xs font-semibold text-white transition hover:bg-action-hover-solid disabled:cursor-not-allowed disabled:bg-action-disabled-bg disabled:text-action-disabled-text"
        >
          {existingHref ? 'Update' : 'Add'}
        </button>
      </div>
    </div>
  )
}
