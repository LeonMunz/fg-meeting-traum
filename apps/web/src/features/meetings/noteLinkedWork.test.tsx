// @vitest-environment happy-dom
//
// Rendering-semantics tests for the compact Note-linked Work Item
// relation card + caption. Covers the caption singular/plural
// contract, the already-available metadata line (Project · assignee
// · status, omitting an unassigned value rather than fabricating one),
// and that the whole card is a single clickable control wired to the
// inspector open handler.
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'

import {
  NoteLinkedWorkCard,
  NoteLinkedWorkCaption,
} from './noteLinkedWork'
import type { ApiLinkedWorkItem } from '../../api/types'

const BASE: ApiLinkedWorkItem = {
  id: 101,
  title: 'Prepare purchase request',
  projectId: 7,
  projectName: 'Lab Ops',
  statusName: 'In progress',
  assigneeNames: ['Alex Dev'],
}

afterEach(() => {
  cleanup()
})

describe('NoteLinkedWorkCaption', () => {
  // A Note has at most one primary linked Work Item (enforced by the
  // existing unique constraint), so the caption is singular:
  // "Linked work".
  it('renders the singular caption', () => {
    render(<NoteLinkedWorkCaption />)
    expect(
      screen.getByText('Linked work', { exact: true }),
    ).toBeInTheDocument()
  })
})

describe('NoteLinkedWorkCard', () => {
  it('shows the Work Item title and available metadata', () => {
    render(<NoteLinkedWorkCard linked={BASE} onOpen={() => {}} />)

    expect(
      screen.getByRole('button', {
        name: 'Open linked work item: Prepare purchase request',
      }),
    ).toBeVisible()

    // Title is the primary, immediately scannable line.
    expect(
      screen.getByText('Prepare purchase request'),
    ).toBeInTheDocument()

    // Project · assignee · status, all already-available payload.
    expect(
      screen.getByText('Lab Ops · Alex Dev · In progress'),
    ).toBeInTheDocument()
  })

  it('omits the assignee segment rather than fabricating it when unassigned', () => {
    render(
      <NoteLinkedWorkCard
        linked={{ ...BASE, assigneeNames: [] }}
        onOpen={() => {}}
      />,
    )

    expect(
      screen.getByText('Lab Ops · In progress'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Unassigned'),
    ).toBeNull()
  })

  it('keeps the card border on the semantic border-subtle token', () => {
    // The token is --color-border-subtle, so the resolvable color
    // utility is `border-border-subtle`; the bare spelling compiles
    // to nothing and would leave the card border on currentColor.
    render(<NoteLinkedWorkCard linked={BASE} onOpen={() => {}} />)
    const card = screen.getByRole('button', {
      name: 'Open linked work item: Prepare purchase request',
    })
    expect(card).toHaveClass('border-border-subtle')
  })

  it('is a single clickable control that invokes the open handler once with the linked item', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <NoteLinkedWorkCard linked={BASE} onOpen={onOpen} />,
    )

    // Exactly one interactive control is the whole card.
    expect(
      container.querySelectorAll('button'),
    ).toHaveLength(1)

    const card = screen.getByRole('button', {
      name: 'Open linked work item: Prepare purchase request',
    })
    // The title text is INSIDE the clickable card, not its own
    // separate control.
    expect(card).toContainElement(
      screen.getByText('Prepare purchase request'),
    )

    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenCalledWith(BASE)
  })
})
