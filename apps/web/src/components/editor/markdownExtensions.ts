import type { AnyExtension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'

/**
 * Single source of truth for the conservative Markdown subset the Work
 * Item Description editor (and, later, its compact variant) supports.
 *
 * This module is framework-agnostic — it only depends on `@tiptap/*`
 * packages, never on React — so the exact same extension set can be used
 * both by the interactive editor (RichMarkdownEditor.tsx) and by headless
 * Markdown round-trip logic (markdownRoundtrip.ts / its tests). Keeping a
 * single factory function is what guarantees the two never drift apart.
 *
 * `@tiptap/markdown` is currently a BETA package — this file (plus
 * markdownRoundtrip.ts) is the only place that imports it. Nothing outside
 * `components/editor` should ever import `@tiptap/markdown` directly, and
 * nothing outside this module ever sees Tiptap's JSON document shape —
 * callers only ever see the canonical Markdown string in and out.
 *
 * Deliberately NOT supported in this slice (see PHASE 1 SCOPE): H1
 * (Work Item title owns that), tables, images/uploads, embeds, math,
 * mentions, Work Item links, collaborative editing, slash commands.
 */

export type MarkdownExtensionsOptions = {
  /** Empty-state placeholder text shown inside the editable surface. */
  placeholder?: string
}

export function createMarkdownExtensions(
  options: MarkdownExtensionsOptions = {},
): AnyExtension[] {
  return [
    StarterKit.configure({
      // The Work Item title already owns the primary heading level —
      // Description may only use H2/H3.
      heading: { levels: [2, 3] },
      // Not part of the supported subset for this slice.
      underline: false,
      link: {
        // Handled by our own click-to-edit popover instead of Tiptap's
        // built-in click behavior — see EditorToolbar's LinkPopover.
        // Native <a> click navigation in read mode is unaffected: this
        // only disables ProseMirror's editable-mode click interception.
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer nofollow',
          target: '_blank',
        },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: false }),
    Placeholder.configure({
      placeholder: options.placeholder ?? '',
    }),
    // Isolated Markdown parse/serialize boundary — see module docblock.
    Markdown,
  ]
}

/**
 * Headless Markdown <-> Tiptap-document round trip, built on the exact
 * same extension set as the interactive editor. Used by the interactive
 * editor is not required to go through this (Editor#getMarkdown /
 * `contentType: 'markdown'` do the same thing internally against a live
 * document) — this exists so the round-trip can also be exercised
 * directly, without mounting a DOM-backed editor, in regression tests.
 */
export function roundtripMarkdown(markdown: string): string {
  const manager = new MarkdownManager({
    extensions: createMarkdownExtensions(),
  })

  return manager.serialize(manager.parse(markdown))
}
