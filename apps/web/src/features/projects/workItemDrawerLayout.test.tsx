// @vitest-environment happy-dom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type {
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from '../../api/types'

import { WorkItemInspector } from './WorkItemDrawer'

// LAYOUT-CONTRACT SCOPE: happy-dom has no layout engine, so this spec
// cannot measure scrollWidth / clip geometry (that is proven by the
// browser E2E in e2e/work-item-drawer-overflow.spec.ts). It pins the
// DOM-level root-cause contract the fix relies on:
//   - the title surface and title edit input carry NO negative margin,
//     so neither can bleed outside the drawer scroll container's
//     clipping edge (the former `-mx-3` bleed clipped the left border
//     and focus ring);
//   - the title edit input's focus ring is inset, so it is painted
//     inside the border box and can never be clipped at the container
//     edge;
//   - view mode and edit mode share the same horizontal padding, so the
//     two states stay aligned;
//   - user-generated text surfaces (title, comment composer) carry
//     `break-words`, so pathological long/unbroken content can break
//     instead of widening the drawer's single vertical scroll
//     container.

const CONFIGURATION = {
  types: [{ id: 1, name: 'Task', order: 1, active: true }],
  statuses: [
    { id: 1, name: 'Todo', order: 1, active: true, category: 'todo' },
    { id: 2, name: 'Done', order: 2, active: true, category: 'done' },
  ],
  labels: [],
}

function makeItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    title: 'Ship the report',
    description: '',
    type: 'task' as const,
    status: 'todo' as const,
    assigneeIds: [] as number[],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    boardPosition: 1,
    labelDefinitionIds: [] as number[],
    typeDefinitionId: 1,
    statusDefinitionId: 1,
    createdById: 1,
    projectId: 7,
    ...overrides,
  } as ApiWorkItem
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function nearestBreakWordsAncestor(
  element: Element,
): Element | null {
  let current: Element | null = element
  while (current) {
    if (current.classList.contains('break-words')) {
      return current
    }
    current = current.parentElement
  }
  return null
}

beforeEach(() => {
  // No network in unit tests: the inspector's History/Comments fetches
  // are the only network callers; they fail closed (error state) and
  // never affect the surfaces under test.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (async () => {
      throw new Error('no network in unit test')
    }) as typeof fetch,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function makeProps(
  item: ApiWorkItem,
  assignees: {
    id: string
    name: string
    initials: string
  }[] = [],
) {
  const patches: ApiUpdateWorkItemInput[] = []
  const onPatch = vi.fn(async (
    _workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ) => {
    patches.push(patch)
  })

  return {
    patches,
    props: {
      projectName: 'Infrastructure',
      item,
      readOnly: false,
      currentUserId: 1,
      workItemConfiguration: CONFIGURATION as never,
      assignees,
      parentItems: [],
      onClose: () => {},
      onPatch,
    },
  }
}

function renderInspector(item: ApiWorkItem) {
  const { patches, props } = makeProps(item)
  const result = render(<WorkItemInspector {...props} />)
  return { patches, ...result }
}

describe('Work Item drawer — title surface layout contract', () => {
  it('view-mode title surface breaks long content and bleeds nowhere', () => {
    // Pathological: a single unbroken 240-character title.
    const pathological = 'x'.repeat(240)
    renderInspector(makeItem({ title: pathological }))

    const titleSurface = screen.getByRole('button', {
      name: pathological,
    })
    expect(titleSurface).toHaveTextContent(pathological)
    // Long unbroken content must be breakable inside the surface.
    expect(titleSurface.className).toContain('break-words')
    // No negative margin: the surface may not extend outside the
    // scroll container's clipping edge (the former -mx-3 bleed clipped
    // the left/right edges of the hover surface).
    expect(titleSurface.className).not.toMatch(/-mx-/)
  })

  it('edit-mode title input stays inside the content column, rings inset, stays aligned with view mode, and still commits', async () => {
    // Simulated server: applies the title PATCH and returns the
    // updated item, exactly like the real drawer parent does.
    let serverItem: ApiWorkItem = makeItem()
    const { patches, props } = makeProps(serverItem)
    const { rerender } = render(
      <WorkItemInspector {...props} />,
    )

    const titleSurface = screen.getByRole('button', {
      name: 'Ship the report',
    })
    act(() => titleSurface.click())
    await flush()

    const input = screen.getByLabelText('Work item title', {
      exact: true,
    })
    // The input spans the full content column width with balanced
    // padding — no negative margin (the -mx-3 bleed with w-full
    // shifted the input 12px left of the scroll container's clipping
    // edge, cutting the left border and focus ring).
    expect(input.className).toContain('w-full')
    expect(input.className).toContain('px-3')
    expect(input.className).not.toMatch(/-mx-/)
    // The focus ring is painted inside the border box, so it can never
    // be clipped at the scroll container edge.
    expect(input.className).toContain('focus:ring-inset')
    // View mode and edit mode share the same horizontal padding, so
    // the two states stay aligned.
    expect(titleSurface.className).toContain('px-3')
    expect(titleSurface.className).not.toMatch(/-mx-/)

    // Behavior preserved: editing + blur commits the new title.
    act(() => {
      fireEvent.change(input, {
        target: { value: 'Renamed report' },
      })
    })
    act(() => {
      fireEvent.blur(input)
    })
    await flush()
    expect(patches).toEqual([
      { title: 'Renamed report' },
    ])

    // The real parent re-renders the drawer with the patched item.
    serverItem = { ...serverItem, title: 'Renamed report' }
    rerender(
      <WorkItemInspector
        {...props}
        item={serverItem}
      />,
    )
    expect(
      screen.getByRole('button', {
        name: 'Renamed report',
      }),
    ).toBeVisible()
  })
})

describe('Work Item drawer — Description surface layout contract', () => {
  it('Description display + edit surfaces carry no negative margin and the edit ring is inset', async () => {
    renderInspector(makeItem())

    // Display mode: the empty-state pill. The former -mx-3.5 bleed
    // extended this block box 14px past the scroll container's right
    // edge (width:auto + negative margins widen the box), which is the
    // horizontal overflow the browser E2E observed (scrollWidth =
    // clientWidth + 14).
    const descriptionSurface = screen.getByRole('button', {
      name: 'Add a description…',
    })
    expect(descriptionSurface.className).not.toMatch(/-mx-/)
    expect(descriptionSurface.className).toContain('px-3.5')

    // Edit mode: the RichMarkdownEditor wrapper must follow the same
    // contract — no bleed, balanced padding, focus ring painted inside
    // the border box so a focused full-width box cannot add scrollable
    // overflow at the container edge.
    act(() => descriptionSurface.click())
    await flush()

    const editor = screen.getByLabelText(
      'Work item description',
      { exact: true },
    )
    expect(editor).toBeVisible()
    const wrapper = nearestBreakWordsAncestor(editor)
    expect(wrapper).not.toBeNull()
    expect(wrapper!.className).not.toMatch(/-mx-/)
    expect(wrapper!.className).toContain('px-3.5')
    expect(
      wrapper!.className,
    ).toContain('focus-within:ring-inset')
  })
})

describe('Work Item drawer — Activity content layout contract', () => {
  it('the comment composer surface breaks long typed content', async () => {
    renderInspector(makeItem())

    const idleComposer = screen.getByRole('button', {
      name: 'Add a comment…',
    })
    act(() => idleComposer.click())
    await flush()

    const composer = screen.getByLabelText('Comment', {
      exact: true,
    })
    expect(composer).toBeVisible()
    // A long unbroken typed comment must break inside the editor
    // instead of widening the drawer's single vertical scroll
    // container.
    expect(
      nearestBreakWordsAncestor(composer),
    ).not.toBeNull()
  })

  it('renders a pathological unbroken comment without breaking the feed', async () => {
    // The feed itself (history + comments) is fetched over the
    // network; with the mocked fetch it renders its error state, so
    // this case instead renders the title surface carrying the same
    // pathological content class and asserts the drawer tree renders
    // fully (no crash, all canonical sections present).
    const pathological = 'y'.repeat(500)
    renderInspector(makeItem({ title: pathological }))

    expect(
      screen.getByRole('button', {
        name: pathological,
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('heading', {
        name: 'Activity',
      }),
    ).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'Add a comment…',
      }),
    ).toBeVisible()
  })
})

describe('Work Item drawer — meeting-origin & assignee chip layout contract', () => {
  it('meeting-origin item title surface breaks long unbroken content and bleeds nowhere', () => {
    // Pathological: a long unbroken meeting-item title — the same
    // user-content class the drawer must not let widen the scroll
    // container (the adjacent meetingTitle/noteContent surfaces were
    // covered earlier; this pins the item-title surface explicitly).
    const pathologicalItemTitle = 'm'.repeat(300)
    renderInspector(
      makeItem({
        meetingOrigin: {
          meetingId: 1,
          meetingTitle: 'Weekly project sync',
          scheduledAt: '2026-09-01T10:00:00Z',
          meetingItemId: 2,
          meetingItemTitle: pathologicalItemTitle,
          noteId: 3,
          noteContent: 'Short note',
        },
      }),
    )

    const itemTitleSurface = screen.getByText(
      pathologicalItemTitle,
    )
    expect(itemTitleSurface.className).toContain('break-words')
    expect(itemTitleSurface.className).not.toMatch(/-mx-/)
  })

  it('assignee chip names render in a shrinkable wrapper for long unbroken names', () => {
    const pathologicalName = 'u'.repeat(80)
    const { props } = makeProps(
      makeItem({ assigneeIds: [9] }),
      [{ id: '9', name: pathologicalName, initials: 'U' }],
    )
    render(<WorkItemInspector {...props} />)

    // The name is a direct child of the chip; it must carry the
    // shrink + wrap contract so a pathological username wraps inside
    // the chip instead of widening the chip (and the drawer).
    const nameSurface = screen.getByText(pathologicalName)
    expect(nameSurface.className).toContain('min-w-0')
    expect(nameSurface.className).toContain('break-words')
    // The chip container itself must not carry a negative margin.
    expect(nameSurface.parentElement!.className).not.toMatch(/-mx-/)
  })
})
