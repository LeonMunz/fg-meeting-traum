import type { Editor } from '@tiptap/core'
import { BubbleMenu } from '@tiptap/react/menus'

import type { MarkdownEditorVariant } from './markdownExtensions'
import { safeIsActive } from './markdownExtensions'
import { LinkPopover } from './LinkPopover'

type ToolbarButtonProps = {
  label: string
  icon?: string
  text?: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

// Shared by both the bottom toolbar and the BubbleMenu so active-state
// styling and focus-preservation behavior never drift between the two.
function ToolbarButton({
  label,
  icon,
  text,
  active,
  disabled,
  onClick,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      // Mousedown (not click) would normally steal focus away from the
      // editor before the command runs — preventDefault here keeps the
      // editor (and the current selection) focused throughout.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={[
        'flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-xs font-semibold transition',
        active
          ? 'bg-primary/15 text-primary'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
        disabled ? 'cursor-not-allowed opacity-40' : '',
      ].join(' ')}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className="material-symbols-outlined text-[16px]"
        >
          {icon}
        </span>
      ) : (
        text
      )}
    </button>
  )
}

function canLink(editor: Editor): boolean {
  return !editor.state.selection.empty || editor.isActive('link')
}

/**
 * The small, quiet formatting controls shared by both surfaces —
 * BubbleMenu (selection) and the bottom-of-editor toolbar (always while
 * editing) render the same underlying commands, just a different subset
 * of buttons, so both call this rather than duplicating command wiring.
 */
function useFormattingCommands(editor: Editor) {
  return {
    bold: {
      active: editor.isActive('bold'),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    italic: {
      active: editor.isActive('italic'),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    code: {
      active: editor.isActive('code'),
      run: () => editor.chain().focus().toggleCode().run(),
    },
    bulletList: {
      active: editor.isActive('bulletList'),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    orderedList: {
      active: editor.isActive('orderedList'),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    taskList: {
      // Not in the compact (Comments) schema — see safeIsActive.
      active: safeIsActive(editor, 'taskList'),
      run: () => editor.chain().focus().toggleTaskList().run(),
    },
    blockquote: {
      active: safeIsActive(editor, 'blockquote'),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    heading2: {
      active: safeIsActive(editor, 'heading', { level: 2 }),
      run: () =>
        editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    heading3: {
      active: safeIsActive(editor, 'heading', { level: 3 }),
      run: () =>
        editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
  }
}

type LinkPopoverControl = {
  open: boolean
  onOpen: () => void
  onClose: () => void
}

/**
 * Quiet, compact toolbar rendered at the bottom of the editing surface —
 * only while editing (see PHASE 1 SCOPE: "no permanent Word-style
 * toolbar"). Also hosts the "Markdown supported" hint and the (single,
 * shared) Link popover — see RichMarkdownEditor, which lifts
 * `linkPopover` state so the BubbleMenu's Link button and Cmd/Ctrl+K
 * open the same popover instance rendered here.
 *
 * Shared by both variants — `variant="compact"` (Work Item Comments)
 * hides Checklist/Quote/H2/H3, which is a deliberately smaller subset of
 * the same commands `variant="full"` (Description) exposes, rather than
 * a second toolbar implementation.
 */
export function EditorBottomToolbar({
  editor,
  linkPopover,
  variant = 'full',
}: {
  editor: Editor
  linkPopover: LinkPopoverControl
  variant?: MarkdownEditorVariant
}) {
  const commands = useFormattingCommands(editor)
  const linkActive = editor.isActive('link')
  const compact = variant === 'compact'

  return (
    <div className="relative mt-2 flex flex-wrap items-center gap-2 border-t border-outline-variant/70 pt-2">
      <span className="mr-1 text-[11px] text-on-surface-variant/80">
        Markdown supported
      </span>

      <div
        role="toolbar"
        aria-label="Formatting"
        className="flex items-center gap-0.5"
      >
        <ToolbarButton
          label="Bold"
          icon="format_bold"
          active={commands.bold.active}
          onClick={commands.bold.run}
        />
        <ToolbarButton
          label="Italic"
          icon="format_italic"
          active={commands.italic.active}
          onClick={commands.italic.run}
        />
        <ToolbarButton
          label="Inline code"
          icon="code"
          active={commands.code.active}
          onClick={commands.code.run}
        />
        <ToolbarButton
          label="Link"
          icon="link"
          active={linkActive || linkPopover.open}
          disabled={!canLink(editor)}
          onClick={() =>
            linkPopover.open
              ? linkPopover.onClose()
              : linkPopover.onOpen()
          }
        />

        <span
          aria-hidden="true"
          className="mx-1 h-4 w-px bg-outline-variant"
        />

        <ToolbarButton
          label="Bullet list"
          icon="format_list_bulleted"
          active={commands.bulletList.active}
          onClick={commands.bulletList.run}
        />
        <ToolbarButton
          label="Numbered list"
          icon="format_list_numbered"
          active={commands.orderedList.active}
          onClick={commands.orderedList.run}
        />

        {/* Checklist/Quote/H2/H3 are outside the compact Markdown
         * subset Comments support (see markdownExtensions.ts) — a
         * comment should never be able to grow into a document. */}
        {!compact && (
          <>
            <ToolbarButton
              label="Checklist"
              icon="checklist"
              active={commands.taskList.active}
              onClick={commands.taskList.run}
            />

            <span
              aria-hidden="true"
              className="mx-1 h-4 w-px bg-outline-variant"
            />

            <ToolbarButton
              label="Quote"
              icon="format_quote"
              active={commands.blockquote.active}
              onClick={commands.blockquote.run}
            />
            <ToolbarButton
              label="Heading 2"
              text="H2"
              active={commands.heading2.active}
              onClick={commands.heading2.run}
            />
            <ToolbarButton
              label="Heading 3"
              text="H3"
              active={commands.heading3.active}
              onClick={commands.heading3.run}
            />
          </>
        )}
      </div>

      {linkPopover.open && (
        <LinkPopover
          editor={editor}
          onClose={linkPopover.onClose}
        />
      )}
    </div>
  )
}

/**
 * Selection-anchored formatting menu — kept to the four commands the
 * product spec calls out explicitly, never a duplicate of every block
 * command already available in the bottom toolbar. Its Link button
 * opens the same shared popover the bottom toolbar renders.
 */
export function EditorBubbleToolbar({
  editor,
  linkPopover,
}: {
  editor: Editor
  linkPopover: LinkPopoverControl
}) {
  const commands = useFormattingCommands(editor)
  const linkActive = editor.isActive('link')

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ state }) =>
        !state.selection.empty && editor.isEditable
      }
      role="toolbar"
      aria-label="Selection formatting"
      className="flex items-center gap-0.5 rounded-lg border border-outline-variant bg-surface-container-lowest p-1 shadow-lg"
    >
      <ToolbarButton
        label="Bold"
        icon="format_bold"
        active={commands.bold.active}
        onClick={commands.bold.run}
      />
      <ToolbarButton
        label="Italic"
        icon="format_italic"
        active={commands.italic.active}
        onClick={commands.italic.run}
      />
      <ToolbarButton
        label="Inline code"
        icon="code"
        active={commands.code.active}
        onClick={commands.code.run}
      />
      <ToolbarButton
        label="Link"
        icon="link"
        active={linkActive || linkPopover.open}
        disabled={!canLink(editor)}
        onClick={() =>
          linkPopover.open
            ? linkPopover.onClose()
            : linkPopover.onOpen()
        }
      />
    </BubbleMenu>
  )
}
