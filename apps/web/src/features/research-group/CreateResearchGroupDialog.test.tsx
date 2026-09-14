// @vitest-environment happy-dom
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

import { ApiError } from '../../api/client'
import { createResearchGroup } from '../../api/research-groups'
import type { ApiResearchGroup } from '../../api/types'

import { CreateResearchGroupDialog } from './CreateResearchGroupDialog'

vi.mock('../../api/research-groups', () => ({
  createResearchGroup: vi.fn(),
}))

function makeCreated(
  overrides: Record<string, unknown> = {},
): ApiResearchGroup {
  return {
    id: 42,
    name: 'New Group',
    role: 'admin',
    ...overrides,
  }
}

function renderOpen(props: {
  onClose?: () => void
  onCreated?: (group: ApiResearchGroup) => void
} = {}) {
  const onClose = props.onClose ?? vi.fn()
  const onCreated = props.onCreated ?? vi.fn()

  const utils = render(
    <CreateResearchGroupDialog
      open
      onClose={onClose}
      onCreated={onCreated}
    />,
  )

  return { onClose, onCreated, ...utils }
}

function submitCreate(name: string) {
  fireEvent.change(screen.getByLabelText('Research group name'), {
    target: { value: name },
  })
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Create research group',
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(createResearchGroup as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('CreateResearchGroupDialog', () => {
  it('renders a fresh name form with no prefill', () => {
    renderOpen()

    const dialog = screen.getByRole('dialog', {
      name: 'Create research group',
    })
    expect(dialog).toBeVisible()
    expect(screen.getByLabelText('Research group name')).toHaveValue('')
    expect(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    ).toBeEnabled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('submits the trimmed name through the canonical create API', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated({ name: '  TrimmEd  ' }),
    )

    renderOpen()
    submitCreate('  TrimmEd  ')

    await waitFor(() => {
      expect(createResearchGroup).toHaveBeenCalledWith({
        name: 'TrimmEd',
      })
    })
  })

  it('calls the caller with the exact server-serialized group and closes on success', async () => {
    const created = makeCreated()
    const onClose = vi.fn()
    const onCreated = vi.fn()
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      created,
    )

    renderOpen({ onClose, onCreated })
    submitCreate('New Group')

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1)
    })
    // No membership or group is synthesized: the caller receives the
    // server response object itself.
    expect(onCreated).toHaveBeenCalledWith(created)
    expect(onCreated.mock.calls[0][0]).toBe(created)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(createResearchGroup).toHaveBeenCalledTimes(1)
  })

  it('blocks submission for a blank name without calling the API', () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeCreated(),
    )

    renderOpen()
    submitCreate('   ')

    expect(
      screen.getByRole('alert').textContent,
    ).toContain('Enter a research group name.')
    expect(createResearchGroup).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
  })

  it('shows the authoritative backend error, keeps the dialog open and the entered name', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(400, {
        error: 'Research Group name is required.',
      }),
    )

    renderOpen()
    submitCreate('Whatever')

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent('Research Group name is required.')
    expect(
      screen.getByRole('dialog', {
        name: 'Create research group',
      }),
    ).toBeVisible()
    expect(
      screen.getByLabelText('Research group name'),
    ).toHaveValue('Whatever')
  })

  it('maps an unexpected failure to the fallback error and retains the name', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    )

    renderOpen()
    submitCreate('Whatever')

    expect(
      await screen.findByRole('alert'),
    ).toHaveTextContent(
      'The research group could not be created. Try again.',
    )
    expect(
      screen.getByLabelText('Research group name'),
    ).toHaveValue('Whatever')
  })

  it('prevents duplicate create submissions while one is in flight', async () => {
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )

    renderOpen()
    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'New Group' },
    })

    const form = screen
      .getByRole('button', { name: 'Create research group' })
      .closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(createResearchGroup).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Creating…' }),
    ).toBeDisabled()
  })

  it('does not close with Escape while a create request is in flight', async () => {
    const onClose = vi.fn()
    ;(createResearchGroup as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {}),
    )

    renderOpen({ onClose })
    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'New Group' },
    })
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Create research group',
      }),
    )

    await waitFor(() => {
      expect(createResearchGroup).toHaveBeenCalledTimes(1)
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes with the Escape key', () => {
    const onClose = vi.fn()

    renderOpen({ onClose })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh interaction on every open', () => {
    const { rerender } = render(
      <CreateResearchGroupDialog
        open
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    )

    fireEvent.change(screen.getByLabelText('Research group name'), {
      target: { value: 'Stale' },
    })

    rerender(
      <CreateResearchGroupDialog
        open={false}
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    )
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(
      <CreateResearchGroupDialog
        open
        onClose={() => undefined}
        onCreated={() => undefined}
      />,
    )
    expect(
      screen.getByLabelText('Research group name'),
    ).toHaveValue('')
  })

  it('renders the modal into document.body so the boundary is location-independent', () => {
    const { container } = renderOpen()

    const dialog = screen.getByRole('dialog', {
      name: 'Create research group',
    })

    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
  })
})
