import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGet, apiPatch, ApiError } from './client'
import {
  fetchWorkspaceNavigationPreferences,
  updateWorkspaceNavigationPreferences,
} from './workspace-navigation-preferences'

import type { ApiWorkspaceNavigationPreferences } from './types'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  ApiError: class ApiError extends Error {
    public readonly status: number

    public readonly detail: unknown

    constructor(status: number, detail: unknown) {
      super(`API error ${status}`)
      this.status = status
      this.detail = detail
    }
  },
}))

/**
 * The snapshot the local UI would send: deliberately NOT already
 * normalized, so the contract tests prove the client never
 * reproduces backend normalization on its own.
 */
const localSnapshot: ApiWorkspaceNavigationPreferences = {
  researchGroupOrder: [3, 1, 2],
  expandedResearchGroups: [3, 9],
  expandedProjectSections: [2, 9],
}

/**
 * The server's normalized answer: stale ID 9 dropped, default
 * order applied — different from the local input on purpose.
 */
const serverSnapshot: ApiWorkspaceNavigationPreferences = {
  researchGroupOrder: [1, 2, 3],
  expandedResearchGroups: [3],
  expandedProjectSections: [2],
}

describe('Workspace navigation preferences client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPatch).mockReset()

    vi.mocked(apiGet).mockResolvedValue(serverSnapshot)
    vi.mocked(apiPatch).mockResolvedValue(serverSnapshot)
  })

  describe('fetchWorkspaceNavigationPreferences', () => {
    it('requests the canonical preferences endpoint', async () => {
      await fetchWorkspaceNavigationPreferences()

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith(
        '/api/me/preferences/workspace-navigation/',
      )
    })

    it('returns the server snapshot unchanged', async () => {
      const result = await fetchWorkspaceNavigationPreferences()

      expect(result).toBe(serverSnapshot)
    })
  })

  describe('updateWorkspaceNavigationPreferences', () => {
    it('PATCHes the canonical preferences endpoint', async () => {
      await updateWorkspaceNavigationPreferences(localSnapshot)

      expect(apiPatch).toHaveBeenCalledTimes(1)
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/me/preferences/workspace-navigation/',
        localSnapshot,
      )
    })

    it('sends the complete snapshot unchanged in canonical wire shape', async () => {
      await updateWorkspaceNavigationPreferences(localSnapshot)

      const sent = vi.mocked(apiPatch).mock.calls[0][1] as ApiWorkspaceNavigationPreferences
      expect(sent).toEqual(localSnapshot)
      expect(Object.keys(sent)).toEqual([
        'researchGroupOrder',
        'expandedResearchGroups',
        'expandedProjectSections',
      ])
    })

    it('returns the normalized server snapshot, not the local input', async () => {
      const result = await updateWorkspaceNavigationPreferences(localSnapshot)

      expect(result).toBe(serverSnapshot)
      expect(result).not.toBe(localSnapshot)
    })
  })

  describe('error propagation', () => {
    it('propagates a GET ApiError unchanged', async () => {
      const error = new ApiError(401, {
        detail: 'Authentication credentials were not provided.',
      })
      vi.mocked(apiGet).mockRejectedValue(error)

      await expect(fetchWorkspaceNavigationPreferences()).rejects.toBe(
        error,
      )
    })

    it('propagates a PATCH ApiError unchanged', async () => {
      const error = new ApiError(400, {
        detail: 'Invalid preference snapshot.',
      })
      vi.mocked(apiPatch).mockRejectedValue(error)

      await expect(
        updateWorkspaceNavigationPreferences(localSnapshot),
      ).rejects.toBe(error)
    })
  })
})
