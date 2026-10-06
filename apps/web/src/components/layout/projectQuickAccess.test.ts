/**
 * Unit contract for the pure global Quick Access composition
 * (frozen contract: docs/design/workspace-sidebar/
 * IMPLEMENTATION_CONTRACT.md, QA-1..QA-5).
 */

import { describe, expect, it } from 'vitest'

import type { ApiProjectQuickAccessItem } from '../../api/types'
import {
  MAX_PROJECT_SHORTCUTS,
  composeProjectShortcuts,
  projectIdFromPath,
} from './projectQuickAccess'

/**
 * A five-item global snapshot deliberately NOT in id, name, or
 * lastOpenedAt order (nulls interleaved, groups interleaved) so
 * any client-side re-sort or re-ranking would be visible.
 */
const snapshot: ApiProjectQuickAccessItem[] = [
  {
    id: 4,
    researchGroupId: 7,
    name: 'Delta',
    lastOpenedAt: '2026-09-01T08:00:00Z',
  },
  {
    id: 12,
    researchGroupId: 3,
    name: 'Omega',
    lastOpenedAt: null,
  },
  {
    id: 2,
    researchGroupId: 7,
    name: 'Alpha',
    lastOpenedAt: '2026-10-01T08:00:00Z',
  },
  {
    id: 31,
    researchGroupId: 3,
    name: 'Kappa',
    lastOpenedAt: '2026-09-15T08:00:00Z',
  },
  {
    id: 1,
    researchGroupId: 9,
    name: 'Beta',
    lastOpenedAt: null,
  },
]

const names = (
  rows: ReturnType<typeof composeProjectShortcuts>,
) => rows.map((row) => row.name)

describe('composeProjectShortcuts', () => {
  it('keeps the exact server order without any client sorting', () => {
    expect(names(composeProjectShortcuts(snapshot, null))).toEqual([
      'Delta',
      'Omega',
      'Alpha',
      'Kappa',
      'Beta',
    ])
  })

  it('never exceeds the max-five presentation cap', () => {
    const six = [
      ...snapshot,
      {
        id: 77,
        researchGroupId: 9,
        name: 'Eta',
        lastOpenedAt: null,
      },
    ]

    const rows = composeProjectShortcuts(six, null)

    expect(rows).toHaveLength(MAX_PROJECT_SHORTCUTS)
    expect(rows).toHaveLength(5)
    // The cap drops the overflow tail; it never reorders.
    expect(names(rows)).toEqual([
      'Delta',
      'Omega',
      'Alpha',
      'Kappa',
      'Beta',
    ])
  })

  it('keeps a current Project in its exact snapshot slot (QA-4)', () => {
    const rows = composeProjectShortcuts(snapshot, {
      id: 2,
      name: 'Alpha',
      researchGroupId: 7,
    })

    // No promotion, no displacement, no duplication.
    expect(names(rows)).toEqual([
      'Delta',
      'Omega',
      'Alpha',
      'Kappa',
      'Beta',
    ])
    expect(rows.filter((row) => row.id === 2)).toHaveLength(1)
    expect(rows[2].contextual).toBe(false)
  })

  it('appends a current Project outside a partial snapshot (QA-5)', () => {
    const partial = snapshot.slice(0, 3)
    const rows = composeProjectShortcuts(partial, {
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
    })

    expect(names(rows)).toEqual([
      'Delta',
      'Omega',
      'Alpha',
      'Iota',
    ])
    expect(rows[3]).toMatchObject({
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
      contextual: true,
    })
  })

  it('replaces only the fifth slot for a full snapshot (QA-5)', () => {
    const rows = composeProjectShortcuts(snapshot, {
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
    })

    expect(rows).toHaveLength(5)
    expect(names(rows)).toEqual([
      'Delta',
      'Omega',
      'Alpha',
      'Kappa',
      'Iota',
    ])
    // The displaced fifth candidate is not duplicated anywhere.
    expect(rows.filter((row) => row.id === 1)).toHaveLength(0)
    expect(rows[4].contextual).toBe(true)
    expect(
      rows.slice(0, 4).every((row) => !row.contextual),
    ).toBe(true)
  })

  it('never mutates the snapshot input', () => {
    const before = snapshot.map((item) => ({ ...item }))

    composeProjectShortcuts(snapshot, {
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
    })
    composeProjectShortcuts(snapshot.slice(0, 3), {
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
    })

    expect(snapshot).toEqual(before)
  })

  it('renders the plain snapshot while the current Project is unresolved', () => {
    expect(
      names(composeProjectShortcuts(snapshot, null)),
    ).toHaveLength(5)
  })

  it('keeps snapshot rows byte-identical around a contextual row', () => {
    const rows = composeProjectShortcuts(snapshot.slice(0, 4), {
      id: 50,
      name: 'Iota',
      researchGroupId: 3,
    })

    // Appended after the four snapshot rows.
    expect(rows[4].contextual).toBe(true)
    expect(rows[4].id).toBe(50)
    expect(
      rows
        .slice(0, 4)
        .every(
          (row, index) => row.id === snapshot[index].id,
        ),
    ).toBe(true)
  })
})

describe('projectIdFromPath', () => {
  it('resolves the concrete Project on entry and tab routes', () => {
    expect(projectIdFromPath('/projects/42')).toBe(42)
    expect(
      projectIdFromPath('/projects/42/work-items'),
    ).toBe(42)
    expect(projectIdFromPath('/projects/42/overview')).toBe(
      42,
    )
    expect(projectIdFromPath('/projects/42/members')).toBe(
      42,
    )
    expect(projectIdFromPath('/projects/42/settings')).toBe(
      42,
    )
  })

  it('returns null everywhere else', () => {
    expect(projectIdFromPath('/')).toBeNull()
    expect(projectIdFromPath('/projects')).toBeNull()
    expect(
      projectIdFromPath('/projects?group=7'),
    ).toBeNull()
    expect(projectIdFromPath('/my-work')).toBeNull()
    expect(projectIdFromPath('/notes')).toBeNull()
    expect(projectIdFromPath('/groups/7')).toBeNull()
    expect(
      projectIdFromPath('/groups/7/settings'),
    ).toBeNull()
    expect(
      projectIdFromPath('/meetings?group=7'),
    ).toBeNull()
    expect(projectIdFromPath('/meetings/9')).toBeNull()
  })

  it('rejects non-positive and non-numeric ids', () => {
    expect(projectIdFromPath('/projects/0')).toBeNull()
    expect(projectIdFromPath('/projects/-3')).toBeNull()
    expect(projectIdFromPath('/projects/abc')).toBeNull()
    expect(
      projectIdFromPath('/projects/12abc'),
    ).toBeNull()
  })

  it('resolves deeper subroutes of the Project subtree as inside it', () => {
    expect(
      projectIdFromPath('/projects/12/work-items/x'),
    ).toBe(12)
  })
})
