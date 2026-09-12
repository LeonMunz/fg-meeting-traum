// @vitest-environment happy-dom

import {
  act,
  cleanup,
  render,
  screen,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { ApiWorkItem } from '../../api/types'

import { WorkItemInspector } from './WorkItemDrawer'

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

afterEach(cleanup)

// SCOPE: happy-dom has no layout engine. This spec proves the React state
// machine (displayBlocked / pendingBlock / blockedReasonEditing and the
// resulting PATCH-vs-local-cancel semantics) — it does NOT prove the
// rendered switch is physically clickable in a real browser (hit-testing,
// overlap, pointer-events). Real-browser clickability must be verified
// manually per the acceptance checklist.
describe('Work Item inspector — Blocked switch', () => {
  it('toggles repeatedly, unblocking via PATCH or local cancel', async () => {
    // No network in unit tests: the inspector's History/Comments fetches
    // are the only callers; the PATCH itself goes through `onPatch`
    // below (simulated, stateful).
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (async () => {
        throw new Error('no network in unit test')
      }) as typeof fetch,
    )

    // Simulated server: applies the PATCH and returns the updated item,
    // exactly like `updateWorkItem` does — the drawer's parent then
    // re-renders the inspector with the new canonical item.
    let serverItem: ApiWorkItem = makeItem({
      blockedReason: 'Waiting on data',
    })
    const patches: Array<
      Record<string, string | null>
    > = []
    const onPatch = vi.fn(async (
      _workItemId: number,
      patch: Record<string, string | null>,
    ) => {
      patches.push(patch)
      serverItem = { ...serverItem, ...patch } as never
      return serverItem
    })

    const props = () => ({
      projectName: 'Infrastructure',
      item: serverItem,
      readOnly: false,
      currentUserId: 1,
      workItemConfiguration: CONFIGURATION as never,
      assignees: [],
      parentItems: [],
      onClose: () => {},
      onPatch: onPatch as unknown as (
        workItemId: number,
        patch: { blockedReason?: string | null },
      ) => Promise<void>,
    })

    // Item is canonically blocked (reason persisted).
    const { rerender } = render(<WorkItemInspector {...props()} />)

    const switchEl = screen.getByRole('switch', {
      name: 'Blocked',
    })

    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'true',
    )

    // ON -> OFF: persisted, so it PATCHes blockedReason: null; once the
    // (simulated) server responds, the inspector re-renders OFF and the
    // reason display disappears.
    act(() => switchEl.click())
    await flush()
    expect(patches).toEqual([
      { blockedReason: null },
    ])
    rerender(<WorkItemInspector {...props()} />)
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(
      screen.queryByText('Waiting on data', { exact: true }),
    ).toBeNull()

    // OFF -> ON: opens the reason editor, still shows ON, no PATCH yet.
    act(() => switchEl.click())
    await flush()
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      screen.getByRole('switch', { name: 'Blocked' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      document.querySelector('[data-placeholder]'),
    ).not.toBeNull()
    expect(patches).toHaveLength(1)

    // ON (pending) -> OFF: nothing was persisted for this pending
    // block, so it cancels locally — no second PATCH.
    act(() => switchEl.click())
    await flush()
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(
      document.querySelector('[data-placeholder]'),
    ).toBeNull()
    expect(patches).toHaveLength(1)

    // OFF -> ON -> OFF again: same pending-cancel behavior, proving the
    // switch never gets wedged after a cycle.
    act(() => switchEl.click())
    await flush()
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'true',
    )
    act(() => switchEl.click())
    await flush()
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'false',
    )
    expect(patches).toHaveLength(1)

    // A freshly-blocked item (e.g. after a reason PATCH settled on the
    // server) toggles OFF through the PATCH path again.
    serverItem = makeItem({ blockedReason: 'Waiting on data' })
    rerender(<WorkItemInspector {...props()} />)
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'true',
    )
    act(() => switchEl.click())
    await flush()
    expect(patches).toEqual([
      { blockedReason: null },
      { blockedReason: null },
    ])
    rerender(<WorkItemInspector {...props()} />)
    expect(switchEl).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })
})
