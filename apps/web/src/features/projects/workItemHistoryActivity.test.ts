import { describe, expect, it } from 'vitest'

import type {
  ApiWorkItemHistoryEvent,
  ApiWorkItemHistoryFromTo,
  ApiWorkItemHistoryParentRef,
} from '../../api/types'

import {
  buildActivityFeed,
  describeWorkItemHistoryEvent,
  getChangedHistoryFields,
} from './WorkItemDrawer'

const ACTOR = {
  id: 1,
  username: 'alex',
  firstName: 'Alex',
  lastName: 'Dev',
}

function makeEvent(
  changes: ApiWorkItemHistoryEvent['changes'],
): ApiWorkItemHistoryEvent {
  return {
    id: 10,
    eventType: 'work_item.updated',
    actor: ACTOR,
    changes,
    createdAt: '2026-09-12T10:00:00Z',
  }
}

describe('Work Item Activity — history change-field detection', () => {
  it('detects the current statusDefinition contract key', () => {
    const fields = getChangedHistoryFields({
      statusDefinition: {
        from: { id: 1, name: 'Todo' },
        to: { id: 2, name: 'In Progress' },
      },
    })

    expect(fields).toEqual(['statusDefinition'])
  })

  it('detects the current typeDefinition contract key', () => {
    const fields = getChangedHistoryFields({
      typeDefinition: {
        from: { id: 1, name: 'Task' },
        to: { id: 2, name: 'Bug' },
      },
    })

    expect(fields).toEqual(['typeDefinition'])
  })

  it('preserves legacy fixed-slug keys and keeps a stable order', () => {
    const fields = getChangedHistoryFields({
      status: { from: 'todo', to: 'in_progress' },
      title: { from: 'A', to: 'B' },
    })

    expect(fields).toEqual(['title', 'status'])
  })
})

describe('Work Item Activity — statusDefinition rendering', () => {
  it('renders a readable summary with the payload definition names', () => {
    const row = describeWorkItemHistoryEvent(
      makeEvent({
        statusDefinition: {
          from: { id: 1, name: 'Todo' },
          to: { id: 2, name: 'In Progress' },
        },
      }),
    )

    expect(row.primary).toBe('Alex Dev changed status')
    expect(row.lines).toEqual([
      { label: null, text: 'Todo → In Progress' },
    ])
  })

  it('uses payload names verbatim for custom, non-legacy status names', () => {
    const row = describeWorkItemHistoryEvent(
      makeEvent({
        statusDefinition: {
          from: { id: 7, name: 'Backlog' },
          to: { id: 8, name: 'In Review (Q3)' },
        },
      }),
    )

    expect(row.primary).toBe('Alex Dev changed status')
    expect(row.lines).toEqual([
      { label: null, text: 'Backlog → In Review (Q3)' },
    ])
  })

  it('keeps a legacy status entry rendering through the slug labels', () => {
    const row = describeWorkItemHistoryEvent(
      makeEvent({
        status: { from: 'todo', to: 'in_progress' },
      }),
    )

    expect(row.primary).toBe('Alex Dev changed status')
    // Legacy entries map slugs through the fixed UI labels (unchanged
    // pre-existing behavior), unlike statusDefinition which uses the
    // payload's project-configured names.
    expect(row.lines).toEqual([
      { label: null, text: 'To do → In progress' },
    ])
  })

  it('renders typeDefinition changes with payload names', () => {
    const row = describeWorkItemHistoryEvent(
      makeEvent({
        typeDefinition: {
          from: { id: 1, name: 'Task' },
          to: { id: 3, name: 'Research Question' },
        },
      }),
    )

    expect(row.primary).toBe('Alex Dev changed type')
    expect(row.lines).toEqual([
      { label: null, text: 'Task → Research Question' },
    ])
  })

  it('renders a multi-field update with labeled statusDefinition detail', () => {
    const row = describeWorkItemHistoryEvent(
      makeEvent({
        title: { from: 'Old', to: 'New' },
        statusDefinition: {
          from: { id: 1, name: 'Todo' },
          to: { id: 2, name: 'In Progress' },
        },
      }),
    )

    expect(row.primary).toBe('Alex Dev updated this work item')
    expect(row.lines).toEqual([
      { label: 'Title', text: 'Old → New' },
      { label: 'Status', text: 'Todo → In Progress' },
    ])
  })

  it('keeps other field rendering unchanged', () => {
    const dueDate = {
      from: null,
      to: '2026-08-21',
    } satisfies ApiWorkItemHistoryFromTo<string | null>

    const dueRow = describeWorkItemHistoryEvent(
      makeEvent({ dueDate }),
    )

    expect(dueRow.primary).toBe('Alex Dev set due date')
    expect(dueRow.lines).toEqual([
      { label: null, text: 'Aug 21' },
    ])

    const parent = {
      from: null,
      to: { id: 9, title: 'Parent item' },
    } satisfies ApiWorkItemHistoryFromTo<
      ApiWorkItemHistoryParentRef | null
    >

    const parentRow = describeWorkItemHistoryEvent(
      makeEvent({ parent }),
    )

    expect(parentRow.primary).toBe('Alex Dev added parent')
    expect(parentRow.lines).toEqual([
      { label: null, text: 'Parent item' },
    ])
  })
})

describe('Work Item Activity — feed assembly', () => {
  it('merges history events with comments by recency', () => {
    const feed = buildActivityFeed(
      [
        {
          id: 1,
          workItemId: 42,
          author: ACTOR,
          body: 'A comment',
          createdAt: '2026-09-12T09:00:00Z',
          updatedAt: '2026-09-12T09:00:00Z',
        },
      ],
      [
        makeEvent({
          statusDefinition: {
            from: { id: 1, name: 'Todo' },
            to: { id: 2, name: 'In Progress' },
          },
        }),
      ],
    )

    expect(feed.map((item) => item.kind)).toEqual([
      'history',
      'comment',
    ])
  })
})
