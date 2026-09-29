// @vitest-environment happy-dom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest'
import { createRef } from 'react'

import {
  RichMarkdownEditor,
  type RichMarkdownEditorHandle,
} from './RichMarkdownEditor'

/**
 * Toolbar presentation contract for the shared editor:
 *
 * - default mode (Work Item Description / Comments and every other
 *   existing consumer): the permanent bottom toolbar with its
 *   "Markdown supported" hint, exactly as before.
 * - contextual mode (Personal Notes): NO permanent bottom toolbar
 *   and no "Markdown supported" copy — the document stays the fully
 *   editable Markdown surface with the identical schema.
 *
 * The selection Bubble toolbar's DOM is inserted by Tiptap only for
 * a live selection (unproducible in the DOM test environment), so
 * its availability in the Notes editor is pinned at the page level
 * (NotesPage.test.tsx) through the editor contract; the keyboard
 * formatting keymap lives in the extensions, which are identical in
 * both modes.
 */

afterEach(() => {
  cleanup()
})

describe('RichMarkdownEditor toolbar modes', () => {
  it('default mode keeps the permanent bottom toolbar (existing consumers unchanged)', () => {
    render(
      <RichMarkdownEditor
        value="# Heading

Body"
        onChange={() => {}}
        ariaLabel="Probe"
      />,
    )

    expect(
      screen.getByRole('toolbar', {
        name: 'Formatting',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Markdown supported'),
    ).toBeInTheDocument()
  })

  it('contextual mode mounts no permanent bottom toolbar and no "Markdown supported" copy', () => {
    const { container } = render(
      <RichMarkdownEditor
        value="# Heading

Body"
        onChange={() => {}}
        ariaLabel="Probe"
        toolbarMode="contextual"
      />,
    )

    expect(
      screen.queryByRole('toolbar', {
        name: 'Formatting',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Markdown supported'),
    ).not.toBeInTheDocument()

    // …and the document remains the fully editable Markdown
    // surface with the same schema (the heading renders, the
    // surface is editable).
    const editable =
      container.querySelector('[contenteditable]')
    expect(editable).not.toBeNull()
    expect(
      editable?.getAttribute('contenteditable'),
    ).toBe('true')
    expect(container.querySelector('h2')).not.toBeNull()
  })

  it('readOnly mode mounts no toolbars at all (regression)', () => {
    render(
      <RichMarkdownEditor
        value="Body only"
        readOnly
        ariaLabel="Probe"
      />,
    )

    expect(screen.queryAllByRole('toolbar')).toHaveLength(0)
  })
})

describe('RichMarkdownEditor focus handle', () => {
  it('focusEnd() moves focus into the editable surface (additive contract)', async () => {
    const ref = createRef<RichMarkdownEditorHandle>()
    render(
      <RichMarkdownEditor
        ref={ref}
        value="# Heading

Body text"
        onChange={() => {}}
        ariaLabel="Probe"
      />,
    )

    await waitFor(() =>
      expect(ref.current).not.toBeNull(),
    )

    act(() => {
      ref.current?.focusEnd()
    })
    // Tiptap's focus command moves the view focus on the next
    // animation frame — let one frame pass before asserting.
    await act(async () => {
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      )
    })

    // Focus lands on the editable document surface — the same
    // element the schema renders into; no remount, no extra DOM.
    const editable =
      document.querySelector('[contenteditable]')
    expect(editable).not.toBeNull()
    expect(document.activeElement).toBe(editable)
  })

  it('renders without a ref exactly as before (existing consumers)', () => {
    render(
      <RichMarkdownEditor
        value="Body"
        ariaLabel="Probe"
      />,
    )

    expect(
      screen.getByRole('toolbar', {
        name: 'Formatting',
      }),
    ).toBeInTheDocument()
    expect(
      document.querySelector('[contenteditable]'),
    ).not.toBeNull()
  })
})
