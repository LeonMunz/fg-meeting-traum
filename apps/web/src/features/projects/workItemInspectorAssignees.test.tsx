// @vitest-environment happy-dom

// CANONICAL REGRESSION — Work Item inspector (edit mode): assignee
// selection while a PATCH is in flight.
//
// Root cause this spec pins: `handleAssigneeToggle` derived the next
// full `assigneeIds` set from `item.assigneeIds` — the last
// ACKNOWLEDGED server state. Because PATCH requests are asynchronous
// (serialized queue, full-set replacement), two rapid toggles both
// read the same stale array, and the second PATCH silently removed
// the first change:
//
//   initial [A, B]
//   add C    -> PATCH [A, B, C]
//   add D (before the first response)
//              -> (old) PATCH [A, B, D]          — C silently lost
//              -> (canonical) PATCH [A, B, C, D]
//
// The inspector now derives every toggle from the LATEST INTENDED
// selection (a synchronous ref + a rendering mirror), presents that
// intended selection in the pills and picker checkboxes while a
// PATCH is pending, and drops the local override only when the
// settled PATCH's intent is still the latest intent — so an
// intermediate, late, or failed result never clobbers a newer
// pending selection. The PATCH queue itself is unchanged: strict
// serialization, one full-set `PATCH { assigneeIds: number[] }` per
// mutation.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
  ApiProjectWorkItemConfiguration,
  ApiUpdateWorkItemInput,
  ApiWorkItem,
} from '../../api/types'

import { WorkItemInspector } from './WorkItemDrawer'

const CONFIGURATION: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 1, name: 'Task', kind: 'task', order: 0, active: true },
  ],
  statuses: [
    {
      id: 10,
      name: 'Todo',
      category: 'todo',
      order: 0,
      active: true,
      isDefault: true,
    },
  ],
  labels: [],
}

const ASSIGNEES = [
  { id: '11', name: 'Alex Rivera', initials: 'AR' },
  { id: '12', name: 'Ben Okafor', initials: 'BO' },
  { id: '13', name: 'Cleo Santos', initials: 'CS' },
  { id: '14', name: 'Dana Wells', initials: 'DW' },
]

function makeItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    projectId: 7,
    title: 'Ship the report',
    description: '',
    assigneeIds: [11, 12],
    parentId: null,
    dueDate: null,
    blockedReason: null,
    completedAt: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    boardPosition: 1,
    labelDefinitionIds: [],
    typeDefinitionId: 1,
    statusDefinitionId: 10,
    createdById: 1,
    ...overrides,
  } as ApiWorkItem
}

// ── Controllable ("gated") PATCH server ─────────────────────────────
//
// Models the real boundary: the parent's onPatch
// (ProjectDetailPage.handlePatchWorkItem) applies the full-set
// replacement atomically to the authoritative Work Item and only
// then settles the response; a failed PATCH applies nothing. Every
// in-flight PATCH is held behind a manual gate, so tests control
// the asynchronous settlement precisely — no network timing, no
// arbitrary sleeps.

type GatedCall = {
  workItemId: number
  patch: ApiUpdateWorkItemInput
  release: (
    ok: boolean,
    message?: string,
  ) => void
}

function makeGatedServer(
  ...items: ApiWorkItem[]
) {
  const serverItems = new Map<
    number,
    ApiWorkItem
  >(
    items.map(
      (item) => [
        item.id,
        { ...item },
      ],
    ),
  )
  const calls: Array<{
    workItemId: number
    patch: ApiUpdateWorkItemInput
  }> = []
  const gates: GatedCall[] = []

  const onPatch = (
    workItemId: number,
    patch: ApiUpdateWorkItemInput,
  ): Promise<void> => {
    calls.push({ workItemId, patch })
    return new Promise(
      (resolve, reject) => {
        gates.push({
          workItemId,
          patch,
          release(
            ok,
            message = 'Work item could not be saved.',
          ) {
            if (!ok) {
              reject(
                new Error(
                  message,
                ),
              )
              return
            }

            const stored =
              serverItems.get(
                workItemId,
              )
            if (stored == null) {
              reject(
                new Error(
                  'unknown Work Item',
                ),
              )
              return
            }

            // The API stores the complete
            // intended set (no deltas).
            serverItems.set(
              workItemId,
              {
                ...stored,
                ...patch,
              } as ApiWorkItem,
            )
            resolve()
          },
        })
      },
    )
  }

  return {
    calls,
    onPatch,
    // Settle the oldest in-flight PATCH in
    // enqueue order (the serialized queue
    // has at most one in flight at a time).
    release(
      ok = true,
      message?: string,
    ) {
      const gate = gates.shift()
      if (gate == null) {
        throw new Error(
          'no PATCH is in flight',
        )
      }
      gate.release(ok, message)
    },
    inFlight: () => gates.length,
    item: (id: number): ApiWorkItem => {
      const stored =
        serverItems.get(id)
      if (stored == null) {
        throw new Error(
          `no server state for ${id}`,
        )
      }
      return stored
    },
  }
}

function renderInspector(
  initialItem: ApiWorkItem,
  ...extraItems: ApiWorkItem[]
) {
  const server = makeGatedServer(
    initialItem,
    ...extraItems,
  )

  const element = (
    item: ApiWorkItem,
  ) => (
    <WorkItemInspector
      projectName="Alpha"
      item={item}
      readOnly={false}
      currentUserId={1}
      workItemConfiguration={CONFIGURATION}
      assignees={ASSIGNEES}
      parentItems={[]}
      onClose={() => {}}
      onPatch={server.onPatch}
    />
  )

  const utils = render(
    element(initialItem),
  )

  // Simulates the parent reconciling its
  // collection with the authoritative Work
  // Item after a settled PATCH (ProjectDetail
  // Page.handlePatchWorkItem's setApiWorkItems)
  // — or switching the inspector to a
  // different item.
  function reconcile(
    item: ApiWorkItem,
  ) {
    utils.rerender(element(item))
  }

  // Settle the oldest in-flight PATCH and
  // flush the microtasks the serialized
  // queue schedules (send the next PATCH,
  // run the settle handlers).
  async function releaseAndDrain(
    ok = true,
    message?: string,
  ) {
    await act(async () => {
      server.release(ok, message)
    })
  }

  return {
    ...utils,
    server,
    reconcile,
    releaseAndDrain,
  }
}

function assigneeTrigger() {
  return screen.getByRole('button', {
    name: /add assignee/i,
  })
}

function assigneeCheckbox(
  name: RegExp,
): HTMLInputElement {
  return screen.getByRole(
    'checkbox',
    { name },
  ) as HTMLInputElement
}

function removePill(
  name: string,
) {
  return screen.getByRole('button', {
    name: `Remove ${name}`,
  })
}

beforeEach(() => {
  // No network in unit tests: the inspector's
  // History/Comments fetches are the only
  // network callers; they fail closed and
  // never affect the assignee surface under
  // test.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (async () => {
      throw new Error(
        'no network in unit test',
      )
    }) as typeof fetch,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe(
  'Work Item inspector — assignee PATCH race contract',
  () => {
    it('adding an assignee PATCHes the exact numeric full set', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(makeItem())

      fireEvent.click(assigneeTrigger())
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )

      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0]).toEqual({
        workItemId: 42,
        patch: {
          assigneeIds: [11, 12, 13],
        },
      })
      // Exactly numeric IDs, complete set —
      // the canonical API contract (no deltas,
      // no string IDs).
      const firstAssigneeIds =
        server.calls[0].patch.assigneeIds
      if (!Array.isArray(firstAssigneeIds)) {
        throw new Error(
          'assigneeIds missing from payload',
        )
      }
      expect(
        firstAssigneeIds.every(
          (id) =>
            typeof id === 'number' &&
            Number.isInteger(id),
        ),
      ).toBe(true)

      await releaseAndDrain()
      reconcile(server.item(42))

      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
    })

    it('removing one assignee preserves all others in the payload', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(
        makeItem({
          assigneeIds: [11, 12, 13],
        }),
      )

      fireEvent.click(
        removePill('Ben Okafor'),
      )

      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0]).toEqual({
        workItemId: 42,
        patch: { assigneeIds: [11, 13] },
      })

      await releaseAndDrain()
      reconcile(server.item(42))

      fireEvent.click(assigneeTrigger())
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
    })

    it('two rapid additions with the first PATCH unresolved produce cumulative payloads and the correct final state', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(makeItem())

      fireEvent.click(assigneeTrigger())

      // Add Cleo — PATCH 1 [11,12,13] is in
      // flight and deliberately left unresolved.
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0].patch).toEqual({
        assigneeIds: [11, 12, 13],
      })
      expect(server.inFlight()).toBe(1)

      // Add Dana before the first response.
      fireEvent.click(
        assigneeCheckbox(/Dana Wells/),
      )

      // The serialized queue has NOT sent
      // PATCH 2 yet…
      expect(server.calls).toHaveLength(1)

      // …but the UI already reflects BOTH
      // intended selections — no stale
      // checkbox or pill state while a
      // PATCH is pending (4 selected -> 2
      // pills + the "+2" chip).
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Dana Wells/),
      ).toBeChecked()
      expect(
        screen.getByRole('button', {
          name: '2 more assignees',
        }),
      ).toBeInTheDocument()

      // Settle PATCH 1: the server holds
      // [11,12,13] and the parent
      // reconciles. The queued PATCH 2 must
      // be CUMULATIVE — derived from the
      // state that already contains Cleo,
      // never from the stale snapshot
      // [11,12].
      await releaseAndDrain()
      expect(server.calls[1].patch).toEqual({
        assigneeIds: [11, 12, 13, 14],
      })
      reconcile(server.item(42)) // [11,12,13]

      // The intermediate re-render must not
      // erase the newer pending selection
      // (Dana).
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Dana Wells/),
      ).toBeChecked()

      await releaseAndDrain()
      reconcile(server.item(42)) // [11,12,13,14]

      // Correct final state: every intended
      // change preserved.
      expect(
        server.item(42).assigneeIds,
      ).toEqual([11, 12, 13, 14])
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Dana Wells/),
      ).toBeChecked()
      expect(server.inFlight()).toBe(0)
    })

    it('rapid removal followed by addition preserves both intended changes', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(makeItem())

      // Remove Ben — PATCH 1 [11] in flight
      // (unresolved).
      fireEvent.click(
        removePill('Ben Okafor'),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0].patch).toEqual({
        assigneeIds: [11],
      })

      // Add Cleo before the first response —
      // derived from the latest intended
      // state [11], not the stale server
      // state [11,12].
      fireEvent.click(assigneeTrigger())
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )

      await releaseAndDrain()
      // Cumulative: Ben removed AND Cleo
      // added.
      expect(server.calls[1].patch).toEqual({
        assigneeIds: [11, 13],
      })
      reconcile(server.item(42)) // [11]

      // The intermediate snapshot must not
      // resurrect Ben, and the pending Cleo
      // must survive it.
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()

      await releaseAndDrain()
      reconcile(server.item(42)) // [11,13]

      expect(server.item(42).assigneeIds).toEqual([
        11, 13,
      ])
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
    })

    it('add then remove before the first response still sends the clobbering PATCH and ends at the original set', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(
        makeItem({ assigneeIds: [11] }),
      )

      fireEvent.click(assigneeTrigger())

      // Add Ben — PATCH 1 [11,12] in flight
      // (unresolved).
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0].patch).toEqual({
        assigneeIds: [11, 12],
      })

      // Remove Ben before the first response.
      // The next set [11] equals the last
      // acknowledged state, but it still
      // MUST be sent — otherwise the
      // in-flight PATCH 1 would leave the
      // server at [11,12] and the removal
      // would be silently lost.
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )

      // The UI reverts to the original
      // selection immediately.
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
      expect(
        screen.queryByRole('button', {
          name: 'Remove Ben Okafor',
        }),
      ).not.toBeInTheDocument()

      await releaseAndDrain()
      // PATCH 2 — the clobbering full set —
      // went out.
      expect(server.calls[1].patch).toEqual({
        assigneeIds: [11],
      })
      reconcile(server.item(42)) // [11,12]

      // The intermediate snapshot must not
      // resurrect Ben while PATCH 2 is
      // queued…
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()

      await releaseAndDrain()
      reconcile(server.item(42)) // [11]

      // …and the final state is exactly the
      // original.
      expect(server.item(42).assigneeIds).toEqual([
        11,
      ])
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
    })

    it('an intermediate parent re-render with an older snapshot does not erase newer pending selections', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(
        makeItem({ assigneeIds: [] }),
      )

      fireEvent.click(assigneeTrigger())
      fireEvent.click(
        assigneeCheckbox(/Alex Rivera/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )

      // Settle PATCH 1 -> server [11]; the
      // parent reconciles with the OLDER
      // intermediate snapshot while PATCH 2
      // is still queued.
      await releaseAndDrain()
      reconcile(server.item(42)) // [11]

      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()

      // Even a stale collection re-render
      // (an older item snapshot) must not
      // erase the pending selection.
      reconcile(makeItem({ assigneeIds: [] }))
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()

      await releaseAndDrain()
      reconcile(server.item(42)) // [11,12]

      expect(server.item(42).assigneeIds).toEqual([
        11, 12,
      ])
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
    })

    it('a rejected PATCH does not leave the unpersisted selection displayed as saved', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(
        makeItem({ assigneeIds: [11] }),
      )

      fireEvent.click(assigneeTrigger())
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0].patch).toEqual({
        assigneeIds: [11, 12],
      })

      // While pending, the intended
      // selection is shown.
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()

      // The PATCH is rejected; the server
      // state is unchanged, and the parent
      // does not reconcile after a failed
      // mutation.
      await releaseAndDrain(
        false,
        'Work item could not be saved.',
      )
      expect(server.item(42).assigneeIds).toEqual([
        11,
      ])

      // The unpersisted assignment must not
      // remain displayed as saved: the UI
      // reverts to the last acknowledged
      // server selection…
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).not.toBeChecked()
      expect(
        screen.queryByRole('button', {
          name: 'Remove Ben Okafor',
        }),
      ).not.toBeInTheDocument()

      // …and the failure is surfaced as a
      // save error.
      expect(
        screen.getByRole('alert', {
          name: 'Work item could not be saved.',
        }),
      ).toBeInTheDocument()

      // The user can retry the toggle, and
      // the retried change is persisted.
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(2),
      )
      expect(server.calls[1].patch).toEqual({
        assigneeIds: [11, 12],
      })

      await releaseAndDrain()
      reconcile(server.item(42)) // [11,12]

      expect(server.item(42).assigneeIds).toEqual([
        11, 12,
      ])
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
    })

    it('a failed earlier PATCH with a newer queued change keeps the newer pending selection until it settles', async () => {
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(
        makeItem({ assigneeIds: [11] }),
      )

      fireEvent.click(assigneeTrigger())

      // Add Ben — PATCH 1 [11,12] in flight
      // (unresolved).
      fireEvent.click(
        assigneeCheckbox(/Ben Okafor/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )

      // Add Cleo before the first response —
      // the newer intent [11,12,13].
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )

      // PATCH 1 FAILS while PATCH 2 is
      // still queued.
      await releaseAndDrain(false)
      expect(server.item(42).assigneeIds).toEqual([
        11,
      ])

      // The failed change must not leave the
      // UI stuck at an unpersisted state —
      // and the newer pending selection (the
      // full intended set, which PATCH 2
      // still carries) must not be discarded.
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()

      // PATCH 2 settles successfully: the
      // full intended set is persisted.
      await releaseAndDrain()
      reconcile(server.item(42)) // [11,12,13]

      expect(server.item(42).assigneeIds).toEqual([
        11, 12, 13,
      ])
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(server.inFlight()).toBe(0)
    })

    it('switching Work Items does not transfer pending assignees, and a late result cannot alter the new item', async () => {
      const item1 = makeItem({
        id: 42,
        assigneeIds: [11],
      })
      const item2 = makeItem({
        id: 43,
        title: 'Other task',
        assigneeIds: [12],
      })
      const {
        server,
        reconcile,
        releaseAndDrain,
      } = renderInspector(item1, item2)

      // On item 1: add Cleo — PATCH in
      // flight (left unresolved).
      fireEvent.click(assigneeTrigger())
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )
      await waitFor(() =>
        expect(server.calls).toHaveLength(1),
      )
      expect(server.calls[0]).toEqual({
        workItemId: 42,
        patch: { assigneeIds: [11, 13] },
      })

      // Switch the inspector to item 2.
      reconcile(item2)

      // (Switching items closes the picker —
      // existing behavior.) Reopen it and
      // verify NO leak: item 2 shows exactly
      // its own server selection.
      fireEvent.click(assigneeTrigger())
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).not.toBeChecked()
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).not.toBeChecked()

      // A pending change on item 2 while the
      // LATE item-1 PATCH is still in
      // flight…
      fireEvent.click(
        assigneeCheckbox(/Cleo Santos/),
      )

      // …settles the late item-1 result
      // first (the serialized queue sends
      // item 2's PATCH only afterwards).
      await releaseAndDrain()

      // Item 1's authoritative state
      // changed; item 2's did not.
      expect(server.item(42).assigneeIds).toEqual([
        11, 13,
      ])
      expect(server.item(43).assigneeIds).toEqual([
        12,
      ])

      // Item 2's PATCH went out addressed to
      // item 2 with item 2's own selection —
      // the late item-1 result changed
      // nothing here.
      expect(server.calls[1]).toEqual({
        workItemId: 43,
        patch: { assigneeIds: [12, 13] },
      })

      // Item 2's pending selection is
      // untouched by the late result (and by
      // re-rendering with item 2's unchanged
      // server object — the picker stays open
      // because the item did not change).
      reconcile(item2)
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Alex Rivera/),
      ).not.toBeChecked()

      await releaseAndDrain()
      reconcile(server.item(43)) // [12,13]

      expect(server.item(43).assigneeIds).toEqual([
        12, 13,
      ])
      expect(
        assigneeCheckbox(/Ben Okafor/),
      ).toBeChecked()
      expect(
        assigneeCheckbox(/Cleo Santos/),
      ).toBeChecked()
      expect(server.inFlight()).toBe(0)
    })
  },
)
