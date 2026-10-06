// @vitest-environment happy-dom

import {
  cleanup,
  render,
  screen,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest'

import { WorkspaceContent } from './WorkspaceContent'

function constrainedFrame(container: HTMLElement) {
  return container.querySelector(
    '[data-fg-workspace-content="constrained"]',
  )
}

function fullFrame(container: HTMLElement) {
  return container.querySelector(
    '[data-fg-workspace-content="full"]',
  )
}

afterEach(() => {
  cleanup()
})

describe('WorkspaceContent — shared content-width contract', () => {
  it('renders ordinary content as constrained by default', () => {
    const { container } = render(
      <WorkspaceContent>
        <p>ordinary workspace content</p>
      </WorkspaceContent>,
    )

    const frame = constrainedFrame(container)
    expect(frame).not.toBeNull()
    expect(frame).toHaveTextContent(
      'ordinary workspace content',
    )
    // No full-width frame is implied by the default variant.
    expect(fullFrame(container)).toBeNull()
  })

  it('renders canvas-like content as full width without a constrained frame', () => {
    const { container } = render(
      <WorkspaceContent variant="full">
        <p>kanban board surface</p>
      </WorkspaceContent>,
    )

    expect(fullFrame(container)).not.toBeNull()
    expect(
      fullFrame(container),
    ).toHaveTextContent('kanban board surface')
    expect(constrainedFrame(container)).toBeNull()
  })

  it('keeps every child inside the same single frame element', () => {
    const { container } = render(
      <WorkspaceContent>
        <header>page heading</header>
        <section>page list</section>
      </WorkspaceContent>,
    )

    const frames = container.querySelectorAll(
      '[data-fg-workspace-content]',
    )
    expect(frames).toHaveLength(1)

    const frame = frames[0] as HTMLElement
    expect(
      frame.contains(
        screen.getByText('page heading'),
      ),
    ).toBe(true)
    expect(
      frame.contains(
        screen.getByText('page list'),
      ),
    ).toBe(true)
  })

  it('accepts an additional className on the frame element', () => {
    const { container } = render(
      <WorkspaceContent className="my-extra-class">
        <p>content</p>
      </WorkspaceContent>,
    )

    const frame = constrainedFrame(
      container,
    ) as HTMLElement
    expect(frame.className).toContain('my-extra-class')
  })
})
