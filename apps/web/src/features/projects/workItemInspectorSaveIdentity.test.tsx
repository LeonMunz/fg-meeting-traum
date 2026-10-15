// @vitest-environment happy-dom

// CANONICAL REGRESSION — Work Item inspector (edit mode): save
// feedback identity across in-place Work Item switches.
//
// Root cause this spec pins: the inspector's save indicator
// (the Saving… / Saved / error message in the drawer header) is
// ONE state machine shared by whichever Work Item is on screen.
// `patchField` captured the initiating Work Item's ID for the
// PATCH itself and for the History refresh, but the save-status
// setters and the delayed "Saved" message timeout were not
// scoped to it: a PATCH for Work Item A that was still queued
// (or whose delayed saved-message timer was still pending)
// wrote its feedback straight into the indicator — so after the
// inspector switched in place to Work Item B, A's late success
// could flash "Saved" on B, A's late rejection could show A's
// error on B, a queued A PATCH could show B as "Saving…", and
// A's delayed timeout could clear B's newer save feedback.
//
// The canonical contract: every queued PATCH owns its feedback.
// A PATCH may only update the visible indicator — saving,
// saved, error, the error message, and the delayed saved-message
// clearing — when the Work Item that initiated the PATCH is the
// one currently displayed, and the delayed clearing additionally
// requires that no newer save operation has since started. The
// serialized PATCH queue, its ordering, and the persistence of
// outstanding PATCHes across an item switch are unchanged.

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
    {
      id: 11,
      name: 'In Progress',
      category: 'in_progress',
      order: 1,
      active: true,
      isDefault: false,
    },
  ],
  labels: [],
}

const ASSIGNEES = [
  { id: '21', name: 'Alex Rivera', initials: 'AR' },
]

function makeItem(
  overrides: Partial<ApiWorkItem> = {},
): ApiWorkItem {
  return {
    id: 42,
    projectId: 7,
    title: 'Item A',
    description: '',
    assigneeIds: [],
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

const ITEM_A = makeItem({
  id: 42,
  title: 'Item A',
})
const ITEM_B = makeItem({
  id: 43,
  title: 'Item B',
})

// ── Controllable ("gated") PATCH server ─────────────────────────────
//
// Models the real boundary: the parent's onPatch (the Project
// board's handlePatchWorkItem) applies the PATCH to the
// authoritative Work Item and only then settles the response; a
// failed PATCH applies nothing. Every in-flight PATCH is held
// behind a manual gate, so tests control the asynchronous
// settlement precisely — no network timing, no arbitrary sleeps.

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

function renderInspector() {
  const server = makeGatedServer(
    ITEM_A,
    ITEM_B,
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

  const utils = render(element(ITEM_A))

  // In-place Work Item switch: the SAME inspector
  // component instance receives a different `item`
  // prop — exactly what the Project board does when
  // the user selects another Work Item on the board
  // (state and the serialized PATCH queue persist).
  function switchTo(
    item: ApiWorkItem,
  ) {
    act(() => {
      utils.rerender(element(item))
    })
  }

  // Settle the oldest in-flight PATCH and flush
  // the microtasks the serialized queue schedules
  // (send the next PATCH, run the settle handlers).
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
    switchTo,
    releaseAndDrain,
  }
}

function statusSelect(): HTMLSelectElement {
  return screen.getByLabelText(
    'Status',
  ) as HTMLSelectElement
}

// Issues one status PATCH (10 → 11) through the
// real Status control.
function triggerStatusPatch() {
  act(() => {
    const select = statusSelect()
    select.value = '11'
    select.dispatchEvent(
      new Event('change', {
        bubbles: true,
      }),
    )
  })
}

// Issues one assignee PATCH (add Alex) through the
// real assignee picker — used as a second,
// independent PATCH behind a queued first one.
function triggerAssigneePatch() {
  fireEvent.click(
    screen.getByRole('button', {
      name: /add assignee/i,
    }),
  )
  fireEvent.click(
    screen.getByRole('checkbox', {
      name: /Alex Rivera/i,
    }),
  )
}

function savedIndicator() {
  return screen.queryByText('Saved', {
    exact: true,
  })
}

function savingIndicator() {
  return screen.queryByText('Saving…')
}

// No save feedback of ANY kind is visible.
function expectNoSaveFeedback() {
  expect(savedIndicator()).toBeNull()
  expect(savingIndicator()).toBeNull()
  expect(
    screen.queryByText(
      'Work item could not be saved.',
    ),
  ).toBeNull()
}

beforeEach(() => {
  // No network in unit tests: the inspector's
  // History/Comments fetches are the only
  // network callers; they fail closed and
  // never affect the save indicator under test.
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
  vi.useRealTimers()
})

describe('Work Item inspector — save feedback identity across in-place item switches', () => {
  it('a successful PATCH for A never displays "Saved" on B after switching', async () => {
    const {
      server,
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    triggerStatusPatch()

    await act(async () => {})
    expect(server.inFlight()).toBe(1)
    // A's own in-flight PATCH shows A as saving.
    expect(savingIndicator()).not.toBeNull()

    // In-place switch to B while A's PATCH is
    // still outstanding.
    switchTo(ITEM_B)
    expectNoSaveFeedback()

    // A's response settles — the queue drains —
    // while B is on screen.
    await releaseAndDrain(true)

    // A's success must not display on B.
    expect(savedIndicator()).toBeNull()
    expectNoSaveFeedback()

    // Persistence is unchanged: A's PATCH was
    // sent for A and applied to A.
    expect(server.calls).toEqual([
      {
        workItemId: 42,
        patch: { statusDefinitionId: 11 },
      },
    ])
    expect(
      server.item(42).statusDefinitionId,
    ).toBe(11)
    expect(
      server.item(43).statusDefinitionId,
    ).toBe(10)
  })

  it('a rejected PATCH for A never displays A\'s error on B after switching', async () => {
    const {
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    triggerStatusPatch()
    await act(async () => {})

    switchTo(ITEM_B)
    expectNoSaveFeedback()

    await releaseAndDrain(
      false,
      'A save failed: quota exceeded.',
    )

    // A's rejection must not display on B —
    // neither the error state nor its message.
    expect(
      screen.queryByRole('alert', {
        name: 'A save failed: quota exceeded.',
      }),
    ).toBeNull()
    expect(
      screen.queryByText(
        'A save failed: quota exceeded.',
      ),
    ).toBeNull()
    expectNoSaveFeedback()
  })

  it('a queued PATCH for A that starts after the switch never shows Saving… or Saved on B', async () => {
    const {
      server,
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    // Two independent PATCHes for A: the first is
    // in flight, the second is queued behind it
    // (serialized queue, unchanged ordering).
    triggerStatusPatch()
    await act(async () => {})
    triggerAssigneePatch()
    await act(async () => {})
    expect(server.inFlight()).toBe(1)

    switchTo(ITEM_B)
    expectNoSaveFeedback()

    // The first PATCH settles; the queued second
    // PATCH for A now STARTS while B is on screen.
    await releaseAndDrain(true)
    expectNoSaveFeedback()

    // The second PATCH settles (queue drained) —
    // A's success must not flash "Saved" on B.
    await releaseAndDrain(true)
    expectNoSaveFeedback()

    // Both of A's PATCHes persisted, in order.
    expect(
      server.calls.map(
        (call) => call.workItemId,
      ),
    ).toEqual([42, 42])
    expect(
      server.calls.map(
        (call) => call.patch,
      ),
    ).toEqual([
      { statusDefinitionId: 11 },
      { assigneeIds: [21] },
    ])
  })

  it('B\'s own successful PATCH displays its own saving and saved states after A\'s in-flight PATCH settles', async () => {
    const {
      server,
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    // A's PATCH is in flight...
    triggerStatusPatch()
    await act(async () => {})
    expect(savingIndicator()).not.toBeNull()

    // ...the inspector switches to B, and B's own
    // PATCH is queued behind A's (serialization).
    switchTo(ITEM_B)
    expectNoSaveFeedback()
    triggerStatusPatch()
    await act(async () => {})
    // B's PATCH has not started yet — A's is
    // still in flight — so B shows no feedback.
    expectNoSaveFeedback()

    // A's PATCH settles (count 2 → 1: no flash);
    // B's PATCH then starts and shows B as saving.
    await releaseAndDrain(true)
    expect(savedIndicator()).toBeNull()
    await act(async () => {})
    expect(savingIndicator()).not.toBeNull()

    // B's own success displays B's "Saved".
    await releaseAndDrain(true)
    expect(savedIndicator()).not.toBeNull()

    // Both PATCHes persisted for their own items.
    expect(
      server.calls.map(
        (call) => call.workItemId,
      ),
    ).toEqual([42, 43])
    expect(
      server.item(42).statusDefinitionId,
    ).toBe(11)
    expect(
      server.item(43).statusDefinitionId,
    ).toBe(11)
  })

  it('B\'s own failed PATCH displays B\'s error, and A\'s earlier rejection never displays on B', async () => {
    const {
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    triggerStatusPatch()
    await act(async () => {})
    switchTo(ITEM_B)
    expectNoSaveFeedback()

    // A's rejection settles while B is on screen
    // (no PATCH queued for B yet).
    await releaseAndDrain(
      false,
      'A save failed: validation.',
    )
    expect(
      screen.queryByRole('alert', {
        name: 'A save failed: validation.',
      }),
    ).toBeNull()
    expect(
      screen.queryByText(
        'A save failed: validation.',
      ),
    ).toBeNull()
    expect(savedIndicator()).toBeNull()

    // B's own PATCH: it starts (B's own saving
    // indicator) and fails with B's own error —
    // which B does display.
    triggerStatusPatch()
    await act(async () => {})
    expect(savingIndicator()).not.toBeNull()
    await releaseAndDrain(
      false,
      'B save failed: due date required.',
    )
    expect(
      screen.getByRole('alert', {
        name: 'B save failed: due date required.',
      }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('alert', {
        name: 'A save failed: validation.',
      }),
    ).toBeNull()
    expect(savedIndicator()).toBeNull()
  })

  it('a delayed saved-message timeout from A cannot clear B\'s newer saved feedback', async () => {
    vi.useFakeTimers()

    const {
      switchTo,
      releaseAndDrain,
    } = renderInspector()

    // A's PATCH settles while A is on screen:
    // the legitimate "Saved" flash for A, with
    // its delayed (1600ms) clearing scheduled.
    triggerStatusPatch()
    await act(async () => {})
    await releaseAndDrain(true)
    expect(savedIndicator()).not.toBeNull()

    // Switch to B (A's delayed clearing is still
    // pending), then move on a little in time.
    switchTo(ITEM_B)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })

    // B's own successful PATCH: B's newer saved
    // feedback, with its own delayed clearing.
    triggerStatusPatch()
    await act(async () => {})
    expect(savingIndicator()).not.toBeNull()
    await releaseAndDrain(true)
    expect(savedIndicator()).not.toBeNull()

    // A's original clearing deadline arrives
    // while B is showing its own newer "Saved":
    // it must not clear B's feedback.
    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(
      savedIndicator(),
    ).not.toBeNull()

    // B's own clearing deadline still applies.
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    expect(savedIndicator()).toBeNull()
    expectNoSaveFeedback()
  })

  it('same-item happy path unchanged: title edit shows Saving…, then Saved, then auto-clears', async () => {
    vi.useFakeTimers()

    const {
      server,
      releaseAndDrain,
    } = renderInspector()

    act(() => {
      screen.getByRole('button', {
        name: 'Item A',
      }).click()
    })

    const input = screen.getByLabelText(
      'Work item title',
      { exact: true },
    )
    act(() => {
      fireEvent.change(input, {
        target: {
          value: 'Item A (revised)',
        },
      })
    })
    act(() => {
      fireEvent.blur(input)
    })
    await act(async () => {})
    expect(server.inFlight()).toBe(1)
    expect(savingIndicator()).not.toBeNull()

    await releaseAndDrain(true)
    expect(savedIndicator()).not.toBeNull()
    expect(
      server.calls,
    ).toEqual([
      {
        workItemId: 42,
        patch: {
          title: 'Item A (revised)',
        },
      },
    ])

    // The delayed clearing auto-clears the
    // indicator for the item still on screen.
    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expectNoSaveFeedback()
  })
})
