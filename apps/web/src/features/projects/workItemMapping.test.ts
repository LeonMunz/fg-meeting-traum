import { describe, expect, it } from 'vitest'

import type {
  ApiProjectWorkItemConfiguration,
} from '../../api/types'

import {
  buildCreateWorkItemInput,
  resolveStatusDefinitionIdByCategory,
  resolveWorkItemDisplay,
  resolveWorkItemStatus,
  resolveWorkItemStatusDefinition,
  resolveWorkItemType,
  resolveWorkItemTypeDefinition,
} from './workItemMapping'

const config: ApiProjectWorkItemConfiguration = {
  types: [
    { id: 1, name: 'Epic', kind: 'epic', order: 0, active: true },
    { id: 2, name: 'Milestone', kind: 'milestone', order: 1, active: true },
    { id: 3, name: 'Deliverable', kind: 'deliverable', order: 2, active: true },
    { id: 4, name: 'Task', kind: 'task', order: 3, active: true },
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
  ],
  labels: [],
}

// Regression: the Board/List white-screen crash happened when a WorkItem
// carried only typeDefinitionId/statusDefinitionId (the canonical backend
// contract) but the UI read the legacy string fields, producing `undefined`.
// These helpers must always resolve to a concrete value.
describe('workItemMapping — definition-based resolution', () => {
  it('maps a Task with a Todo status', () => {
    const out = resolveWorkItemDisplay(
      { typeDefinitionId: 4, statusDefinitionId: 10 },
      config,
    )

    expect(out.type).toBe('task')
    expect(out.status).toBe('todo')
    expect(out.typeLabel).toBe('Task')
  })

  it('maps an Epic in Review', () => {
    const out = resolveWorkItemDisplay(
      { typeDefinitionId: 1, statusDefinitionId: 12 },
      config,
    )

    expect(out.type).toBe('epic')
    expect(out.status).toBe('review')
    expect(out.typeLabel).toBe('Epic')
  })

  it('falls back to task/todo for unknown definition IDs', () => {
    const out = resolveWorkItemDisplay(
      { typeDefinitionId: 999, statusDefinitionId: 999 },
      config,
    )

    expect(out.type).toBe('task')
    expect(out.status).toBe('todo')
    expect(out.typeLabel).toBe('Task')
  })

  it('never returns undefined type, status, or typeLabel', () => {
    const combos = [
      { typeDefinitionId: 1, statusDefinitionId: 10 },
      { typeDefinitionId: 2, statusDefinitionId: 11 },
      { typeDefinitionId: 3, statusDefinitionId: 13 },
      { typeDefinitionId: 4, statusDefinitionId: 10 },
    ]

    for (const combo of combos) {
      const out = resolveWorkItemDisplay(combo, config)
      expect(out.type).toBeDefined()
      expect(out.status).toBeDefined()
      expect(out.typeLabel).toBeDefined()
      expect(typeof out.typeLabel).toBe('string')
      expect(out.typeLabel.length).toBeGreaterThan(0)
    }
  })

  it('resolves to safe defaults when the config is missing', () => {
    expect(resolveWorkItemStatus(10, null)).toBe('todo')
    expect(resolveWorkItemType(4, null)).toBe('task')

    const out = resolveWorkItemDisplay(
      { typeDefinitionId: 4, statusDefinitionId: 10 },
      null,
    )
    expect(out).toEqual({
      type: 'task',
      status: 'todo',
      typeLabel: 'Task',
    })
  })
})


describe('resolveWorkItemType — semantic kind resolution', () => {
  it('resolves a RENAMED canonical definition by its stored kind, not its display name', () => {
    const renamed: ApiProjectWorkItemConfiguration = {
      types: [
        {
          id: 1,
          name: 'Big Initiative',
          kind: 'epic',
          order: 0,
          active: true,
        },
        {
          id: 2,
          name: 'Experiment step',
          kind: 'task',
          order: 1,
          active: true,
        },
      ],
      statuses: [],
      labels: [],
    }

    // The display names no longer match any built-in label — the
    // semantic kind must come from the stored `kind`.
    expect(resolveWorkItemType(1, renamed)).toBe('epic')
    expect(resolveWorkItemType(2, renamed)).toBe('task')
  })

  it('never attributes a canonical kind to a custom (kind null) definition from its display name', () => {
    const customNamedEpic: ApiProjectWorkItemConfiguration = {
      types: [
        {
          id: 9,
          name: 'Epic',
          kind: null,
          order: 0,
          active: true,
        },
      ],
      statuses: [],
      labels: [],
    }

    // A custom type named exactly "Epic" carries NO canonical
    // kind: the pre-kind name-based lookup returned 'epic' here,
    // which the runtime rule forbids. The resolver keeps the
    // neutral fallback instead.
    expect(
      resolveWorkItemType(9, customNamedEpic),
    ).toBe('task')
  })

  it('keeps the neutral fallback for unresolvable definitions', () => {
    expect(resolveWorkItemType(999, config)).toBe('task')
    expect(resolveWorkItemType(null, config)).toBe('task')
    expect(resolveWorkItemType(4, null)).toBe('task')
  })
})


describe('resolveWorkItemTypeDefinition — canonical ID lookup', () => {
  it('returns the referenced definition by ID (no inference, no fallback)', () => {
    expect(
      resolveWorkItemTypeDefinition(4, config),
    ).toEqual({
      id: 4,
      name: 'Task',
      kind: 'task',
      order: 3,
      active: true,
    })
  })

  it('returns an INACTIVE referenced definition (it stays attached to existing WorkItems)', () => {
    const withInactive: ApiProjectWorkItemConfiguration = {
      ...config,
      types: [
        ...config.types,
        {
          id: 99,
          name: 'Archive milestone',
          kind: 'milestone',
          order: 9,
          active: false,
        },
      ],
    }

    expect(
      resolveWorkItemTypeDefinition(99, withInactive),
    ).toMatchObject({
      id: 99,
      name: 'Archive milestone',
      active: false,
    })
  })

  it('returns null when the configuration is missing or the ID cannot be resolved', () => {
    expect(
      resolveWorkItemTypeDefinition(4, null),
    ).toBeNull()
    expect(
      resolveWorkItemTypeDefinition(null, config),
    ).toBeNull()
    expect(
      resolveWorkItemTypeDefinition(999, config),
    ).toBeNull()
  })
})


describe('buildCreateWorkItemInput — form state to definition-ID payload', () => {
  it('builds the canonical payload from definition IDs', () => {
    const payload = buildCreateWorkItemInput({
      title: '  Write spec  ',
      description: '  Details ',
      typeDefinitionId: 4,
      statusDefinitionId: 12,
      assigneeIds: ['1', '2'],
      parentId: '7',
      dueDate: '2026-01-15',
      blockedReason: null,
    })

    expect(payload).toEqual({
      typeDefinitionId: 4,
      statusDefinitionId: 12,
      title: 'Write spec',
      description: 'Details',
      assigneeIds: [1, 2],
      parentId: 7,
      dueDate: '2026-01-15',
    })
  })

  it('omits optional fields that are not set', () => {
    const payload = buildCreateWorkItemInput({
      title: 'Task',
      description: '',
      typeDefinitionId: 3,
      statusDefinitionId: null,
      assigneeIds: [],
      parentId: null,
      dueDate: null,
      blockedReason: null,
    })

    expect(payload).toEqual({
      typeDefinitionId: 3,
      title: 'Task',
      description: '',
    })
    // statusDefinitionId must be intentionally absent (backend default).
    expect('statusDefinitionId' in payload).toBe(false)
    expect('assigneeIds' in payload).toBe(false)
    expect('parentId' in payload).toBe(false)
  })

  it('never emits legacy type/status string fields', () => {
    const payload = buildCreateWorkItemInput({
      title: 'Task',
      description: '',
      typeDefinitionId: 4,
      statusDefinitionId: 10,
      assigneeIds: [],
      parentId: null,
      dueDate: null,
      blockedReason: null,
    })

    expect('type' in payload).toBe(false)
    expect('status' in payload).toBe(false)
    expect(payload.typeDefinitionId).toBe(4)
    expect(payload.statusDefinitionId).toBe(10)
  })

  it('throws when no type definition is selected', () => {
    expect(() =>
      buildCreateWorkItemInput({
        title: 'Task',
        description: '',
        typeDefinitionId: null,
        statusDefinitionId: 10,
        assigneeIds: [],
        parentId: null,
        dueDate: null,
        blockedReason: null,
      }),
    ).toThrow('A Work Item type is required.')
  })
})


describe('resolveStatusDefinitionIdByCategory — board/status category to definition ID', () => {
  it('resolves each status category to its configured definition', () => {
    expect(
      resolveStatusDefinitionIdByCategory('todo', config),
    ).toBe(10)
    expect(
      resolveStatusDefinitionIdByCategory('in_progress', config),
    ).toBe(11)
    expect(
      resolveStatusDefinitionIdByCategory('review', config),
    ).toBe(12)
    expect(
      resolveStatusDefinitionIdByCategory('done', config),
    ).toBe(13)
  })

  it('returns null when the config is missing', () => {
    expect(resolveStatusDefinitionIdByCategory('review', null)).toBeNull()
  })
})


describe('resolveWorkItemStatusDefinition — canonical ID lookup', () => {
  it('returns the referenced definition by ID (no inference, no fallback)', () => {
    expect(
      resolveWorkItemStatusDefinition(12, config),
    ).toEqual({
      id: 12,
      name: 'Review',
      category: 'review',
      order: 2,
      active: true,
      isDefault: false,
    })
  })

  it('returns an INACTIVE referenced definition (it stays attached to existing WorkItems)', () => {
    const withInactive: ApiProjectWorkItemConfiguration = {
      ...config,
      statuses: [
        ...config.statuses,
        {
          id: 99,
          name: 'Archive review',
          category: 'review',
          order: 9,
          active: false,
          isDefault: false,
        },
      ],
    }

    expect(
      resolveWorkItemStatusDefinition(99, withInactive),
    ).toMatchObject({
      id: 99,
      name: 'Archive review',
      category: 'review',
      active: false,
    })
  })

  it('never substitutes a same-category definition for an unresolvable ID', () => {
    // id 999 is not configured, but an ACTIVE `review` definition
    // (id 12) exists — the lookup must still return null (the
    // inspector shows an explicit unavailable state, it must not
    // silently display another status).
    expect(
      resolveWorkItemStatusDefinition(999, config),
    ).toBeNull()
  })

  it('returns null when the configuration is missing or the ID is null', () => {
    expect(
      resolveWorkItemStatusDefinition(12, null),
    ).toBeNull()
    expect(
      resolveWorkItemStatusDefinition(null, config),
    ).toBeNull()
  })
})
