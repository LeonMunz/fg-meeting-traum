// @vitest-environment happy-dom
import {
  cleanup,
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

import { listResearchGroups } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

import { ResearchGroupProvider } from './ResearchGroupProvider'
import { useResearchGroup } from './useResearchGroup'

vi.mock('../../api/research-groups', () => ({
  listResearchGroups: vi.fn(),
}))

const SEED_GROUPS: ApiResearchGroup[] = [
  { id: 11, name: 'Existing Group', role: 'member' },
]

function Probe() {
  const {
    groups,
    activeResearchGroupId,
    addResearchGroup,
  } = useResearchGroup()

  return (
    <div>
      <output aria-label="Groups">{JSON.stringify(groups)}</output>
      <output aria-label="Active group id">
        {String(activeResearchGroupId)}
      </output>
      <button
        type="button"
        onClick={() =>
          addResearchGroup({ id: 99, name: 'Brand New', role: 'admin' })
        }
      >
        Add created group
      </button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(listResearchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(
    SEED_GROUPS,
  )
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('ResearchGroupProvider', () => {
  it('registers a server-created group in canonical state and activates it', async () => {
    render(
      <ResearchGroupProvider>
        <Probe />
      </ResearchGroupProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByLabelText('Active group id'),
      ).toHaveTextContent('11')
    })

    screen.getByRole('button', {
      name: 'Add created group',
    }).click()

    await waitFor(() => {
      expect(
        screen.getByLabelText('Groups'),
      ).toHaveTextContent(
        JSON.stringify([
          ...SEED_GROUPS,
          { id: 99, name: 'Brand New', role: 'admin' },
        ]),
      )
      expect(
        screen.getByLabelText('Active group id'),
      ).toHaveTextContent('99')
    })
  })

  it('persists the newly created group as the active group preference', async () => {
    render(
      <ResearchGroupProvider>
        <Probe />
      </ResearchGroupProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByLabelText('Active group id'),
      ).toHaveTextContent('11')
    })

    screen.getByRole('button', {
      name: 'Add created group',
    }).click()

    await waitFor(() => {
      expect(
        screen.getByLabelText('Active group id'),
      ).toHaveTextContent('99')
    })

    expect(
      window.localStorage.getItem(
        'fg-workspace.active-research-group-id',
      ),
    ).toBe('99')
  })

  it('does not duplicate a group that is already in canonical state', async () => {
    render(
      <ResearchGroupProvider>
        <Probe />
      </ResearchGroupProvider>,
    )

    await waitFor(() => {
      expect(
        screen.getByLabelText('Active group id'),
      ).toHaveTextContent('11')
    })

    screen.getByRole('button', {
      name: 'Add created group',
    }).click()
    screen.getByRole('button', {
      name: 'Add created group',
    }).click()

    await waitFor(() => {
      expect(
        screen.getByLabelText('Groups'),
      ).toHaveTextContent(
        JSON.stringify([
          ...SEED_GROUPS,
          { id: 99, name: 'Brand New', role: 'admin' },
        ]),
      )
    })

    const groupsText = screen
      .getByLabelText('Groups')
      .textContent!
    expect(
      groupsText.split('Brand New').length - 1,
    ).toBe(1)
  })
})
