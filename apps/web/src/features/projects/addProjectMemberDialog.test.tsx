// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from '@testing-library/react'
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  AddProjectMemberDialog,
  type DirectoryUser,
} from './AddProjectMemberDialog'

const USERS: DirectoryUser[] = [
  {
    id: '2',
    name: 'Chris Taylor',
    username: 'chris',
    initials: 'CT',
  },
  {
    id: '3',
    name: 'Maria Gomez',
    username: 'maria',
    initials: 'MG',
  },
  {
    id: '4',
    name: 'Laura Chen',
    username: 'laura',
    initials: 'LC',
  },
]

function renderDialog(
  overrides: Partial<{
    open: boolean
    users: DirectoryUser[]
    excludedUserIds: string[]
    onClose: () => void
    onAdd: (
      user: DirectoryUser,
      role: 'owner' | 'member' | 'viewer',
    ) => Promise<void>
  }> = {},
) {
  const onClose =
    overrides.onClose ?? vi.fn()
  const onAdd =
    overrides.onAdd ??
    vi.fn(async () => {})
  const result: RenderResult = render(
    <AddProjectMemberDialog
      open={overrides.open ?? true}
      users={overrides.users ?? USERS}
      excludedUserIds={
        overrides.excludedUserIds ?? ['1']
      }
      onClose={onClose}
      onAdd={onAdd}
    />,
  )

  return {
    onClose,
    onAdd,
    dialog: () =>
      screen.getByRole('dialog', {
        name: 'Add project member',
      }),
    ...result,
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('AddProjectMemberDialog search', () => {
  it('filters by username as the user types', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'chris' } },
    )

    expect(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    ).toBeInTheDocument()
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@maria)/,
        })
        .length,
    ).toBe(0)
  })

  it('filters by display name', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'gomez' } },
    )

    expect(
      within(d)
        .getByRole('button', {
          name: /(@maria)/,
        }),
    ).toBeInTheDocument()
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@chris)/,
        })
        .length,
    ).toBe(0)
  })

  it('searches case-insensitively', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'CHRIS' } },
    )

    expect(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    ).toBeInTheDocument()
  })

  it('trims surrounding whitespace from the query', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: '   maria   ' } },
    )

    expect(
      within(d)
        .getByRole('button', {
          name: /(@maria)/,
        }),
    ).toBeInTheDocument()
  })

  it('shows a distinct no-match state for an unmatched query', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'zzz-nobody' } },
    )

    expect(
      within(d).getByText('No matching people'),
    ).toBeInTheDocument()
    expect(
      within(d).getByText(
        'Try a different name or username.',
      ),
    ).toBeInTheDocument()

    // The "everyone has access" message must not be used for
    // a mere no-match.
    expect(
      within(d).queryByText(
        'Everyone already has project access',
      ),
    ).not.toBeInTheDocument()
  })
})

describe('AddProjectMemberDialog candidate pool', () => {
  it('renders the compact search-free empty state when the eligible pool is empty', () => {
    const { dialog } = renderDialog({
      excludedUserIds: ['2', '3', '4'],
    })
    const d = dialog()

    // The empty-pool message is shown ...
    expect(
      within(d).getByText(
        'Everyone already has project access',
      ),
    ).toBeInTheDocument()
    expect(
      within(d).getByText(
        'All research-group members are already members of this project.',
      ),
    ).toBeInTheDocument()

    // ... and the state is search-free: no Select person
    // label, no search input, no result region.
    expect(
      within(d).queryByText('Select person'),
    ).not.toBeInTheDocument()
    expect(
      within(d).queryByLabelText('Select person'),
    ).not.toBeInTheDocument()
    expect(
      within(d).queryByRole('searchbox'),
    ).not.toBeInTheDocument()
    expect(
      within(d).queryByText('No matching people'),
    ).not.toBeInTheDocument()
  })

  it('has no role section, no Add member CTA, and only a neutral Close in the empty-pool state', () => {
    const { dialog } = renderDialog({
      excludedUserIds: ['2', '3', '4'],
    })
    const d = dialog()

    expect(
      within(d).queryByText('Project role'),
    ).not.toBeInTheDocument()
    expect(
      within(d).queryAllByRole('radio'),
    ).toHaveLength(0)
    expect(
      within(d).queryByRole('button', {
        name: /Add member/,
      }),
    ).not.toBeInTheDocument()
    expect(
      within(d)
        .getByRole('button', {
          name: 'Close',
        })
    ).toBeInTheDocument()
    expect(
      within(d).queryByRole('button', {
        name: 'Cancel',
      }),
    ).not.toBeInTheDocument()
  })

  it('keeps already-current Project members out of the candidates', () => {
    const { dialog } = renderDialog({
      excludedUserIds: ['1', '2'],
    })
    const d = dialog()

    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@chris)/,
        })
        .length,
    ).toBe(0)
    expect(
      within(d)
        .getByRole('button', {
          name: /(@maria)/,
        }),
    ).toBeInTheDocument()
  })
})

describe('AddProjectMemberDialog selection and role', () => {
  it('hides the role section until a person is selected', () => {
    renderDialog()

    expect(
      screen.queryByText('Project role'),
    ).not.toBeInTheDocument()

    // Add member stays disabled before selection.
    expect(
      screen.getByRole('button', {
        name: /Add member/,
      }),
    ).toBeDisabled()
  })

  it('reveals the canonical roles with Member as the default after selection', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    expect(
      within(d).getByText('Project role'),
    ).toBeInTheDocument()

    for (const role of [
      'Owner',
      'Member',
      'Viewer',
    ]) {
      expect(
        within(d)
          .getByRole('radio', {
            name: new RegExp(`^${role}`),
          })
      ).toBeInTheDocument()
    }

    expect(
      within(d).getByRole('radio', {
        name: /^Member/,
      }),
    ).toBeChecked()

    // Search and the candidate list are gone; the selected
    // person is rendered exactly once, with no "Selected"
    // label and no candidate row for the same user.
    expect(
      within(d).queryByLabelText('Select person'),
    ).not.toBeInTheDocument()
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@chris)/,
        })
        .length,
    ).toBe(0)
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@maria)/,
        })
        .length,
    ).toBe(0)
    expect(
      within(d).getAllByText('Chris Taylor'),
    ).toHaveLength(1)
    expect(
      within(d).queryByText('Selected'),
    ).not.toBeInTheDocument()
    expect(
      within(d).queryByText('SELECTED'),
    ).not.toBeInTheDocument()

    // The selection is removable.
    expect(
      within(d).getByRole('button', {
        name: 'Remove selected person',
      }),
    ).toBeInTheDocument()

    expect(
      within(d).getByRole('button', {
        name: /Add member/,
      }),
    ).toBeEnabled()
  })

  it('clearing the selection hides the role section again', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    expect(
      within(d).getByText('Project role'),
    ).toBeInTheDocument()

    fireEvent.click(
      within(d).getByRole('button', {
        name: 'Remove selected person',
      }),
    )

    expect(
      within(d).queryByText('Project role'),
    ).not.toBeInTheDocument()

    // Search and the candidate list return.
    expect(
      within(d)
        .getByLabelText('Select person'),
    ).toBeInTheDocument()
    expect(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    ).toBeInTheDocument()
    expect(
      within(d)
        .getByRole('button', {
          name: /(@maria)/,
        }),
    ).toBeInTheDocument()

    expect(
      within(d).getByRole('button', {
        name: /Add member/,
      }),
    ).toBeDisabled()

    // The dialog stays open.
    expect(d).toBeVisible()
  })

  it('restores the in-flight query and its filtered results after removing the selection', () => {
    const { dialog } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'chr' } },
    )

    expect(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    ).toBeInTheDocument()
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@maria)/,
        })
        .length,
    ).toBe(0)

    // Selecting replaces the search and the results with the
    // selected-person row.
    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    expect(
      within(d).queryByLabelText('Select person'),
    ).not.toBeInTheDocument()
    expect(
      within(d).getByText('Chris Taylor'),
    ).toBeInTheDocument()

    // Removing the selection restores the search and the
    // filtered result set for the same query.
    fireEvent.click(
      within(d).getByRole('button', {
        name: 'Remove selected person',
      }),
    )

    expect(
      within(d)
        .getByLabelText('Select person'),
    ).toHaveValue('chr')
    expect(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    ).toBeInTheDocument()
    expect(
      within(d)
        .queryAllByRole('button', {
          name: /(@maria)/,
        })
        .length,
    ).toBe(0)
  })
})

describe('AddProjectMemberDialog submission', () => {
  it('adds the selected user through the provided mutation path and closes', async () => {
    const {
      dialog,
      onAdd,
      onClose,
    } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'chris' } },
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /Add member/,
        }),
    )

    expect(onAdd).toHaveBeenCalledTimes(1)
    const [user, role] =
      vi.mocked(onAdd).mock
        .calls[0] as [
        DirectoryUser,
        string,
      ]

    expect(user).toMatchObject({
      id: '2',
      username: 'chris',
    })
    expect(role).toBe('member')

    await vi.waitFor(() =>
      expect(onClose).toHaveBeenCalled(),
    )
  })

  it('respects an explicitly changed role', async () => {
    const {
      dialog,
      onAdd,
    } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'laura' } },
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@laura)/,
        }),
    )

    fireEvent.click(
      within(d)
        .getByRole('radio', {
          name: /^Viewer/,
        }),
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /Add member/,
        }),
    )

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'laura',
      }),
      'viewer',
    )
  })

  it('keeps the dialog open with an error when the mutation fails', async () => {
    const {
      dialog,
      onClose,
    } = renderDialog({
      onAdd: async () =>
        Promise.reject(
          new Error(
            'Project member could not be added.',
          ),
        ),
    })
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'chris' } },
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /Add member/,
        }),
    )

    await vi.waitFor(() =>
      expect(
        within(d).getByRole('alert'),
      ).toBeInTheDocument(),
    )

    expect(onClose).not.toHaveBeenCalled()
    expect(d).toBeVisible()
  })

  it('resets query and selection when the dialog closes and reopens', () => {
    const { dialog, rerender } = renderDialog()
    const d = dialog()

    fireEvent.change(
      within(d).getByLabelText('Select person'),
      { target: { value: 'chris' } },
    )

    fireEvent.click(
      within(d)
        .getByRole('button', {
          name: /(@chris)/,
        }),
    )

    expect(
      within(d).getByText('Project role'),
    ).toBeInTheDocument()

    rerender(
      <AddProjectMemberDialog
        open={false}
        users={USERS}
        excludedUserIds={['1']}
        onClose={() => {}}
        onAdd={async () => {}}
      />,
    )

    expect(
      screen.queryByRole('dialog', {
        name: 'Add project member',
      }),
    ).not.toBeInTheDocument()

    rerender(
      <AddProjectMemberDialog
        open
        users={USERS}
        excludedUserIds={['1']}
        onClose={() => {}}
        onAdd={async () => {}}
      />,
    )

    const reopened = dialog()

    expect(
      within(reopened)
        .getByLabelText('Select person'),
    ).toHaveValue('')
    expect(
      within(reopened).queryByText('Selected'),
    ).not.toBeInTheDocument()
    expect(
      within(reopened).queryByText('Project role'),
    ).not.toBeInTheDocument()
  })
})
