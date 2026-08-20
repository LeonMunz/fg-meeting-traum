import type { AnyExtension, Editor, JSONContent } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'

/**
 * Single source of truth for the conservative Markdown subset the Work
 * Item Description editor (`variant: 'full'`) and Work Item Comments
 * (`variant: 'compact'`) support.
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
 * Deliberately NOT supported by `full` (see PHASE 1 SCOPE): H1 (Work Item
 * title owns that), tables, images/uploads, embeds, math, mentions, Work
 * Item links, collaborative editing, slash commands.
 *
 * `compact` (Work Item Comments) is a strictly smaller subset of `full` —
 * a comment should never be able to grow into a document. It keeps only
 * paragraphs, bullet/numbered lists, bold/italic/inline code, and links;
 * it drops every heading level, blockquote, horizontal rule, fenced code
 * block, and strikethrough. Checklists are deliberately left out too —
 * nothing in the compact toolbar exposes them, and the product spec only
 * asks for them if they "fall out cleanly"; enabling the schema without a
 * button would be a half-feature, not a clean one.
 */

export type MarkdownEditorVariant = 'full' | 'compact'

/**
 * `@tiptap/markdown`'s parser has a hard-coded fallback for a couple of
 * token types (see its `parseFallbackToken`) that runs whenever no
 * registered extension claims the token — and that fallback ASSUMES the
 * corresponding node type still exists in the schema. It doesn't: that's
 * the whole point of omitting Heading/CodeBlock from `compact`. Left
 * unhandled, loading a pre-existing plain-text Comment that happens to
 * start with a literal "#" throws ("Unknown node type: heading") instead
 * of rendering as a normal paragraph — a real crash, not a cosmetic
 * difference, and a direct violation of "existing plain-text comments
 * must remain valid". These two extensions register BEFORE that fallback
 * runs and downgrade the token to an ordinary paragraph instead, keeping
 * the text. They contribute no schema node/mark of their own (plain
 * `Extension`, not `Node`), so they don't reopen the door heading/code
 * blocks were removed through.
 */
function compactFallbackExtensions(): AnyExtension[] {
  return [
    Extension.create({
      name: 'compactHeadingFallback',
      markdownTokenName: 'heading',
      parseMarkdown: (token, helpers) =>
        helpers.createNode(
          'paragraph',
          undefined,
          helpers.parseInline(token.tokens ?? []),
        ),
    }),
    Extension.create({
      name: 'compactCodeBlockFallback',
      markdownTokenName: 'code',
      parseMarkdown: (token, helpers) =>
        helpers.createNode('paragraph', undefined, [
          helpers.createTextNode(token.text ?? ''),
        ]),
    }),
  ]
}

export type MarkdownExtensionsOptions = {
  /** Empty-state placeholder text shown inside the editable surface. */
  placeholder?: string
  /** Which conservative Markdown subset to build. Defaults to `full`. */
  variant?: MarkdownEditorVariant
}

export function createMarkdownExtensions(
  options: MarkdownExtensionsOptions = {},
): AnyExtension[] {
  const variant = options.variant ?? 'full'
  const compact = variant === 'compact'

  return [
    StarterKit.configure({
      // The Work Item title already owns the primary heading level —
      // Description may only use H2/H3. Comments allow no heading at
      // all (see module docblock).
      heading: compact ? false : { levels: [2, 3] },
      // Comments stay inline-only structure: no quoted blocks, no
      // rules, no fenced/large code blocks, no strikethrough. `false`
      // (not merely hidden) is what keeps the node/mark out of the
      // schema entirely — see safeIsActive in EditorToolbar.tsx.
      blockquote: compact ? false : undefined,
      horizontalRule: compact ? false : undefined,
      codeBlock: compact ? false : undefined,
      strike: compact ? false : undefined,
      // Not part of the supported subset for either variant.
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
    // Checklists are a `full`-only extra — see module docblock for why
    // `compact` doesn't include them.
    ...(compact ? [] : [TaskList, TaskItem.configure({ nested: false })]),
    Placeholder.configure({
      placeholder: options.placeholder ?? '',
    }),
    // Isolated Markdown parse/serialize boundary — see module docblock.
    Markdown,
    // Compact-only crash/data-loss guard — see compactFallbackExtensions.
    ...(compact ? compactFallbackExtensions() : []),
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
export function roundtripMarkdown(
  markdown: string,
  variant: MarkdownEditorVariant = 'full',
): string {
  const manager = new MarkdownManager({
    extensions: createMarkdownExtensions({ variant }),
  })

  return manager.serialize(manager.parse(markdown))
}

/**
 * "Has meaningful content" check for Markdown that will be submitted as a
 * Comment — deliberately not just `markdown.trim() !== ''`, since e.g. an
 * empty bullet item (`-`, with nothing after it) is non-empty Markdown
 * text that still renders as visually blank. Parses through the same extension set the compact
 * editor itself uses, then checks the resulting document for any actual
 * text, which is the smallest check that stays correct for every node
 * type in the compact schema without hand-rolling Markdown-syntax
 * stripping.
 */
export function isMarkdownContentEmpty(
  markdown: string,
  variant: MarkdownEditorVariant = 'full',
): boolean {
  if (markdown.trim() === '') {
    return true
  }

  const manager = new MarkdownManager({
    extensions: createMarkdownExtensions({ variant }),
  })

  return !jsonContentHasText(manager.parse(markdown))
}

function jsonContentHasText(node: JSONContent): boolean {
  if (typeof node.text === 'string' && node.text.trim() !== '') {
    return true
  }

  return (node.content ?? []).some(jsonContentHasText)
}

/**
 * Flattens Markdown to a single-line, syntax-free approximation of its
 * text — for a quiet, truncatable summary line (e.g. a History/Activity
 * entry) that needs to read naturally, never for rendered content (use
 * `RichMarkdownEditor readOnly` for that). Reuses the same parse step as
 * the rest of this module rather than a hand-rolled Markdown-syntax
 * stripper, so it stays correct for every node type in either variant's
 * schema without drifting from what the editor itself understands.
 */
export function markdownToPlainText(
  markdown: string,
  variant: MarkdownEditorVariant = 'full',
): string {
  if (markdown.trim() === '') {
    return ''
  }

  const manager = new MarkdownManager({
    extensions: createMarkdownExtensions({ variant }),
  })

  const textRuns: string[] = []
  collectJsonContentText(manager.parse(markdown), textRuns)

  // Sibling text runs already carry their own inner spacing (marks
  // split adjacent text but never eat the spaces around them) — joining
  // with an extra space and collapsing runs is what keeps separate
  // blocks (paragraphs, list items) from getting mashed together
  // without overcounting whitespace that was already there.
  return textRuns.join(' ').replace(/\s+/g, ' ').trim()
}

function collectJsonContentText(
  node: JSONContent,
  out: string[],
): void {
  if (typeof node.text === 'string') {
    out.push(node.text)
    return
  }

  for (const child of node.content ?? []) {
    collectJsonContentText(child, out)
  }
}

/**
 * `editor.isActive(name, …)` throws ("There is no node/mark type named
 * …") when `name` isn't registered in the current schema at all — which
 * is exactly the case for e.g. `blockquote`/`heading`/`taskList` under
 * `variant="compact"` (they're omitted from createMarkdownExtensions
 * entirely, not just hidden from the toolbar). Both EditorToolbar.tsx
 * and RichMarkdownEditor.tsx use this instead of calling
 * `editor.isActive` directly for anything that isn't in every variant's
 * schema.
 */
export function safeIsActive(
  editor: Editor,
  name: string,
  attributes?: Record<string, unknown>,
): boolean {
  // A destroyed editor's `schema` is nulled out by Tiptap itself
  // (Editor#destroy) even though the `Editor` object reference can
  // still be around briefly (e.g. one last reactive callback firing
  // during teardown) — guard against that here too, not just at the
  // call sites.
  if (editor.isDestroyed) {
    return false
  }

  const inSchema =
    name in editor.schema.nodes || name in editor.schema.marks

  return inSchema && editor.isActive(name, attributes)
}
