// @vitest-environment happy-dom
//
// Rendered behavioral contract for the Meeting -> Work Item
// creation dialog (agenda item AND Meeting Note sources):
//
//   Default type
//   - the Project's ACTIVE canonical Task definition
//     (`kind === 'task'`) is selected by default — never the first
//     active definition, never by display name or position;
//   - a renamed canonical Task is still selected; a custom type
//     merely named "Task" (`kind = null`) never is;
//   - an inactive canonical Task is never selected;
//   - without an active canonical Task the type stays unselected
//     (explicit "Select a type…" placeholder) and Create requires an
//     explicit valid choice — no silent Epic fallback.
//
//   Explicit user choices
//   - a manually selected type is never silently reset while
//     editing; the submitted payload carries the actually selected
//     typeDefinitionId.
//
//   Reset behavior
//   - closing and reopening the dialog restores the Task default;
//   - switching Projects reinitializes to the new Project's own
//     canonical Task; a stale configuration response for the
//     previous Project never overrides the current selection.
//
// Assertions inspect the VISIBLE selection (the rendered <select>
// state) and the actual creation API payload — never implementation
// strings.

import {
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

import * as meetingsApi from '../../api/meetings'
import * as projectsApi from '../../api/projects'
import type {
  ApiMeetingItem,
  ApiMeetingNote,
  ApiProject,
  ApiProjectMembership,
  ApiProjectWorkItemConfiguration,
  ApiWorkItem,
  ApiWorkItemTypeDefinition,
} from '../../api/types'

import {
  CreateMeetingWorkItemDialog,
  type CreateMeetingWorkItemDialogProps,
} from './CreateMeetingWorkItemDialog'

vi.mock('../../api/meetings', async (importOriginal) => {
  const actual = await importOriginal<typeof meetingsApi>()

  return {
    ...actual,
    createWorkItemFromMeetingItem: vi.fn(),
  }
})

vi.mock('../../api/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof projectsApi>()

  return {
    ...actual,
    listProjects: vi.fn(),
    listProjectMemberships: vi.fn(),
    getProjectWorkItemConfiguration: vi.fn(),
  }
})

/* ── Fixtures ─────────────────────────────────────────────────── */

function makeType(
  overrides:
    & Partial<ApiWorkItemTypeDefinition>
    & Pick<
      ApiWorkItemTypeDefinition,
      'id' | 'name' | 'kind'
    >,
): ApiWorkItemTypeDefinition {
  return { order: 0, active: true, ...overrides }
}

const STATUSES: ApiProjectWorkItemConfiguration['statuses'] = [
  {
    id: 10,
    name: 'To do',
    category: 'todo',
    order: 0,
    active: true,
    isDefault: true,
  },
  {
    id: 11,
    name: 'In progress',
    category: 'in_progress',
    order: 1,
    active: true,
    isDefault: false,
  },
  {
    id: 12,
    name: 'Review',
    category: 'review',
    order: 2,
    active: true,
    isDefault: false,
  },
  {
    id: 13,
    name: 'Done',
    category: 'done',
    order: 3,
    active: true,
    isDefault: false,
  },
]

// Realistic starter configuration: Epic commonly appears FIRST.
const EPIC = makeType({
  id: 1,
  name: 'Epic',
  kind: 'epic',
  order: 0,
})
const MILESTONE = makeType({
  id: 2,
  name: 'Milestone',
  kind: 'milestone',
  order: 1,
})
const DELIVERABLE = makeType({
  id: 3,
  name: 'Deliverable',
  kind: 'deliverable',
  order: 2,
})
const TASK = makeType({
  id: 4,
  name: 'Task',
  kind: 'task',
  order: 3,
})

const RENAMED_CANONICAL_TASK = makeType({
  id: 5,
  name: 'Experiment step',
  kind: 'task',
  order: 1,
})

// Owner-created custom type whose display name merely says "Task".
const CUSTOM_TASK_NAMED = makeType({
  id: 6,
  name: 'Task',
  kind: null,
  order: 0,
})

// Second Project with its own, differently-IDed definitions.
const BETA_EPIC = makeType({
  id: 21,
  name: 'Epic',
  kind: 'epic',
  order: 0,
})
const BETA_TASK = makeType({
  id: 24,
  name: 'Task',
  kind: 'task',
  order: 1,
})

function makeConfiguration(
  types: ApiWorkItemTypeDefinition[],
): ApiProjectWorkItemConfiguration {
  return { types, statuses: STATUSES, labels: [] }
}

const ALPHA_CANONICAL = [EPIC, MILESTONE, DELIVERABLE, TASK]
const BETA_CANONICAL = [BETA_EPIC, BETA_TASK]

const PROJECT_ALPHA: ApiProject = {
  id: 7,
  researchGroupId: 1,
  name: 'Alpha',
  description: '',
  status: 'active',
  archivedAt: null,
  currentUserRole: 'owner',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const PROJECT_BETA: ApiProject = {
  ...PROJECT_ALPHA,
  id: 8,
  name: 'Beta',
  currentUserRole: 'member',
}

const MEMBERSHIPS: ApiProjectMembership[] = [
  {
    id: 1,
    role: 'owner',
    addedAt: null,
    user: {
      id: 1,
      username: 'alex',
      firstName: 'Alex',
      lastName: 'Dev',
    },
  },
]

const NOTE: ApiMeetingNote = {
  id: 55,
  meetingItemId: 31,
  author: {
    id: 1,
    username: 'alex',
    firstName: 'Alex',
    lastName: 'Dev',
  },
  content: 'Order 5 mL of buffer for the assay',
  createdAt: '2026-09-02T09:00:00Z',
  updatedAt: '2026-09-02T09:00:00Z',
  linkedWorkItem: null,
}

const AGENDA_ITEM: ApiMeetingItem = {
  id: 31,
  meetingId: 9,
  meetingSectionId: 5,
  title: 'Prepare experiment protocol',
  contextNotes: 'Collect reagent list.',
  content: '# Prepare experiment protocol',
  position: 0,
  outcome: 'not_discussed',
  followUpSchedule: null,
  workItemIds: [],
  notes: [NOTE],
  createdById: 1,
  createdAt: '2026-09-02T08:00:00Z',
  updatedAt: '2026-09-02T08:00:00Z',
}

const CREATED_ITEM: ApiWorkItem = {
  id: 900,
  projectId: 7,
  title: 'Prepare experiment protocol',
  description: 'Collect reagent list.',
  typeDefinitionId: TASK.id,
  statusDefinitionId: 10,
  boardPosition: null,
  labelDefinitionIds: [],
  assigneeIds: [],
  parentId: null,
  dueDate: null,
  blockedReason: null,
  completedAt: null,
  createdAt: '2026-09-03T00:00:00Z',
  updatedAt: '2026-09-03T00:00:00Z',
  createdById: 1,
  meetingOrigin: null,
}

/* ── Test seams ───────────────────────────────────────────────── */

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

type DialogOverrides = Partial<
  Pick<
    CreateMeetingWorkItemDialogProps,
    'open' | 'defaultProjectId' | 'sourceNote'
  >
>

function renderDialog(overrides: DialogOverrides = {}) {
  const onCreated = vi.fn()
  const onClose = vi.fn()

  const props: CreateMeetingWorkItemDialogProps = {
    open: true,
    researchGroupId: 1,
    meetingItem: AGENDA_ITEM,
    defaultProjectId: 7,
    sourceNote: null,
    onCreated,
    onClose,
    ...overrides,
  }

  const utils = render(<CreateMeetingWorkItemDialog {...props} />)

  return {
    onCreated,
    onClose,
    rerenderOpen(open: boolean) {
      utils.rerender(
        <CreateMeetingWorkItemDialog {...props} open={open} />,
      )
    },
    ...utils,
  }
}

function typeSelect() {
  return screen.getByLabelText('Type') as HTMLSelectElement
}

function projectSelect() {
  return screen.getByLabelText('Project') as HTMLSelectElement
}

function createButton() {
  return screen.getByRole('button', {
    name: /create work item/i,
  })
}

/** Wait for the Project configuration to have loaded into the form. */
async function waitForTypeOptions(
  ...names: string[]
) {
  for (const name of names) {
    await screen.findByRole('option', { name })
  }
}

function selectedTypeText() {
  const selected = typeSelect().selectedOptions[0]

  return selected ? selected.textContent : null
}

beforeEach(() => {
  vi.mocked(projectsApi.listProjects).mockResolvedValue([
    PROJECT_ALPHA,
    PROJECT_BETA,
  ])
  vi.mocked(
    projectsApi.listProjectMemberships,
  ).mockResolvedValue(MEMBERSHIPS)
  vi.mocked(
    projectsApi.getProjectWorkItemConfiguration,
  ).mockImplementation(async (projectId: number) => {
    if (projectId === PROJECT_BETA.id) {
      return makeConfiguration(BETA_CANONICAL)
    }

    return makeConfiguration(ALPHA_CANONICAL)
  })
  vi.mocked(
    meetingsApi.createWorkItemFromMeetingItem,
  ).mockResolvedValue(CREATED_ITEM)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/* ── Default type selection ───────────────────────────────────── */

describe(
  'CreateMeetingWorkItemDialog — default type',
  () => {
    it('defaults to the canonical Task even when Epic is the first active definition', async () => {
      renderDialog()

      await waitForTypeOptions('Task')

      // Visible selection: Task, not the first-listed Epic.
      expect(typeSelect().value).toBe(String(TASK.id))
      expect(selectedTypeText()).toBe('Task')
    })

    it('selects a renamed canonical Task by its kind, not by name or position', async () => {
      vi.mocked(
        projectsApi.getProjectWorkItemConfiguration,
      ).mockResolvedValue(
        makeConfiguration([
          EPIC,
          RENAMED_CANONICAL_TASK,
          DELIVERABLE,
        ]),
      )

      renderDialog()

      await waitForTypeOptions('Experiment step')

      expect(typeSelect().value).toBe(
        String(RENAMED_CANONICAL_TASK.id),
      )
      expect(selectedTypeText()).toBe('Experiment step')
    })

    it('never auto-selects a custom definition named Task without a canonical kind, and requires an explicit choice', async () => {
      vi.mocked(
        projectsApi.getProjectWorkItemConfiguration,
      ).mockResolvedValue(
        makeConfiguration([CUSTOM_TASK_NAMED, EPIC]),
      )

      renderDialog()

      await waitForTypeOptions('Epic')

      // The kind-null "Task" (and no other type) is left
      // unselected, with an explicit placeholder.
      expect(typeSelect().value).toBe('')
      expect(
        screen.getByRole('option', {
          name: 'Select a type…',
        }),
      ).toBeInTheDocument()
      expect(createButton()).toBeDisabled()

      // An explicit valid choice unblocks creation and is
      // submitted as-is.
      fireEvent.change(typeSelect(), {
        target: { value: String(EPIC.id) },
      })
      expect(createButton()).toBeEnabled()

      fireEvent.click(createButton())

      await waitFor(() =>
        expect(
          meetingsApi.createWorkItemFromMeetingItem,
        ).toHaveBeenCalledWith(
          AGENDA_ITEM.id,
          expect.objectContaining({
            typeDefinitionId: EPIC.id,
          }),
        ),
      )
    })

    it('does not select an inactive canonical Task and requires an explicit active alternative', async () => {
      vi.mocked(
        projectsApi.getProjectWorkItemConfiguration,
      ).mockResolvedValue(
        makeConfiguration([
          EPIC,
          { ...TASK, active: false },
        ]),
      )

      renderDialog()

      await waitForTypeOptions('Epic')

      // Only the inactive Task definition exists besides Epic —
      // no type may be auto-selected.
      expect(typeSelect().value).toBe('')
      expect(
        screen.getByRole('option', {
          name: 'Select a type…',
        }),
      ).toBeInTheDocument()
      // The inactive Task is not offered at all.
      expect(
        screen.queryAllByRole('option'),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: String(TASK.id) }),
        ]),
      )
      expect(createButton()).toBeDisabled()

      // Explicit selection of the only active type works.
      fireEvent.change(typeSelect(), {
        target: { value: String(EPIC.id) },
      })
      expect(createButton()).toBeEnabled()
    })

    it('keeps the existing no-active-types state (disabled select + explanation, Create disabled)', async () => {
      vi.mocked(
        projectsApi.getProjectWorkItemConfiguration,
      ).mockResolvedValue(makeConfiguration([]))

      renderDialog()

      await waitForTypeOptions('No work item types available')

      expect(typeSelect()).toBeDisabled()
      expect(createButton()).toBeDisabled()
      expect(
        screen.getByRole('alert'),
      ).toHaveTextContent(
        'Select a valid project and type before creating a work item.',
      )
    })
  },
)

/* ── Explicit user selection ──────────────────────────────────── */

describe(
  'CreateMeetingWorkItemDialog — explicit user selection',
  () => {
    it('keeps a manually selected type while editing the form and submits its id', async () => {
      renderDialog()

      await waitForTypeOptions('Epic')
      expect(typeSelect().value).toBe(String(TASK.id))

      // Deliberate user choice: Epic.
      fireEvent.change(typeSelect(), {
        target: { value: String(EPIC.id) },
      })
      expect(typeSelect().value).toBe(String(EPIC.id))
      expect(selectedTypeText()).toBe('Epic')

      // Editing other fields must not silently reset the type.
      fireEvent.change(screen.getByLabelText('Title'), {
        target: { value: 'Epic the pipeline' },
      })
      fireEvent.change(screen.getByLabelText('Description'), {
        target: { value: 'Expanded context.' },
      })
      expect(typeSelect().value).toBe(String(EPIC.id))
      expect(selectedTypeText()).toBe('Epic')

      fireEvent.click(createButton())

      await waitFor(() =>
        expect(
          meetingsApi.createWorkItemFromMeetingItem,
        ).toHaveBeenCalledWith(
          AGENDA_ITEM.id,
          {
            projectId: PROJECT_ALPHA.id,
            typeDefinitionId: EPIC.id,
            title: 'Epic the pipeline',
            description: 'Expanded context.',
            statusDefinitionId: 10,
            assigneeIds: [],
            dueDate: null,
            meetingNoteId: null,
          },
        ),
      )
    })
  },
)

/* ── Reset behavior ───────────────────────────────────────────── */

describe(
  'CreateMeetingWorkItemDialog — reset behavior',
  () => {
    it('restores the canonical Task default when the dialog is closed and reopened', async () => {
      const { rerenderOpen } = renderDialog()

      await waitForTypeOptions('Task')
      expect(typeSelect().value).toBe(String(TASK.id))

      // A deliberate non-default choice…
      fireEvent.change(typeSelect(), {
        target: { value: String(EPIC.id) },
      })
      expect(typeSelect().value).toBe(String(EPIC.id))

      // …is dropped by a fresh creation session.
      rerenderOpen(false)
      expect(
        screen.queryByRole('dialog'),
      ).not.toBeInTheDocument()

      rerenderOpen(true)
      await waitForTypeOptions('Task')
      expect(typeSelect().value).toBe(String(TASK.id))
      expect(selectedTypeText()).toBe('Task')
    })

    it('reinitializes the default to the switched Project Task and drops the stale configuration response', async () => {
      const pendingAlpha =
        deferred<ApiProjectWorkItemConfiguration>()

      vi.mocked(
        projectsApi.getProjectWorkItemConfiguration,
      ).mockImplementation(async (projectId: number) => {
        if (projectId === PROJECT_ALPHA.id) {
          return pendingAlpha.promise
        }

        return makeConfiguration(BETA_CANONICAL)
      })

      renderDialog()

      // Alpha is preselected; its configuration is still in
      // flight.
      await waitForTypeOptions('Beta')
      expect(projectSelect().value).toBe(
        String(PROJECT_ALPHA.id),
      )

      // Switch to Beta before Alpha's response arrives.
      fireEvent.change(projectSelect(), {
        target: { value: String(PROJECT_BETA.id) },
      })
      await waitForTypeOptions('Task')
      expect(typeSelect().value).toBe(String(BETA_TASK.id))
      expect(selectedTypeText()).toBe('Task')

      // The stale Alpha response must be discarded.
      pendingAlpha.resolve(makeConfiguration(ALPHA_CANONICAL))
      await waitFor(() => {
        expect(typeSelect().value).toBe(String(BETA_TASK.id))
      })
      expect(Array.from(typeSelect().options)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ value: String(BETA_EPIC.id) }),
          expect.objectContaining({ value: String(BETA_TASK.id) }),
        ]),
      )
      expect(
        Array.from(typeSelect().options).map(
          (option) => option.value,
        ),
      ).not.toContain(String(TASK.id))
    })
  },
)

/* ── Creation payload ─────────────────────────────────────────── */

describe(
  'CreateMeetingWorkItemDialog — creation payload',
  () => {
    it('submits the canonical Task id for an untouched agenda-item form', async () => {
      const { onCreated, onClose } = renderDialog()

      await waitForTypeOptions('Task')

      // Untouched form: prefilled title/description, default
      // Task, no assignees or due date.
      fireEvent.click(createButton())

      await waitFor(() =>
        expect(
          meetingsApi.createWorkItemFromMeetingItem,
        ).toHaveBeenCalledWith(
          AGENDA_ITEM.id,
          {
            projectId: PROJECT_ALPHA.id,
            typeDefinitionId: TASK.id,
            title: AGENDA_ITEM.title,
            description: AGENDA_ITEM.contextNotes,
            statusDefinitionId: 10,
            assigneeIds: [],
            dueDate: null,
            meetingNoteId: null,
          },
        ),
      )

      expect(onCreated).toHaveBeenCalledWith(
        CREATED_ITEM,
        expect.objectContaining({
          projectId: PROJECT_ALPHA.id,
          statusName: 'To do',
        }),
      )
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('applies the same Task default to the Meeting Note source and anchors the payload to the Note', async () => {
      renderDialog({ sourceNote: NOTE })

      await waitForTypeOptions('Task')

      // The same canonical Task default as the agenda flow…
      expect(typeSelect().value).toBe(String(TASK.id))
      expect(selectedTypeText()).toBe('Task')
      // …with the Note-derived title prefill.
      expect(
        (screen.getByLabelText('Title') as HTMLInputElement)
          .value,
      ).toBe(NOTE.content)

      fireEvent.click(createButton())

      await waitFor(() =>
        expect(
          meetingsApi.createWorkItemFromMeetingItem,
        ).toHaveBeenCalledWith(
          AGENDA_ITEM.id,
          expect.objectContaining({
            typeDefinitionId: TASK.id,
            meetingNoteId: NOTE.id,
          }),
        ),
      )
    })
  },
)
