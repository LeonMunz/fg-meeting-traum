import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGet, apiPost, ApiError } from './client'
import {
  fetchGlobalProjectQuickAccess,
  fetchProjectQuickAccess,
  recordProjectOpen,
} from './project-quick-access'

import type {
  ApiProjectNavigationOpen,
  ApiProjectQuickAccessItem,
} from './types'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
 * The server's ordered Quick Access answer: deliberately NOT in id,
 * name, or lastOpenedAt order (first entry is the OLDEST of the
 * opened timestamps, the newest sits second, and null entries are
 * interleaved, not last). If the client ever re-sorted, filtered,
 * or normalized the result, these assertions would fail.
 */
const serverQuickAccess: ApiProjectQuickAccessItem[] = [
  {
    id: 4,
    researchGroupId: 7,
    name: 'Delta',
    lastOpenedAt: '2026-09-01T08:00:00Z',
  },
  {
    id: 2,
    researchGroupId: 7,
    name: 'Alpha',
    lastOpenedAt: '2026-10-01T08:00:00Z',
  },
  {
    id: 9,
    researchGroupId: 7,
    name: 'Zeta',
    lastOpenedAt: null,
  },
  {
    id: 5,
    researchGroupId: 7,
    name: 'Epsilon',
    lastOpenedAt: '2026-09-15T08:00:00Z',
  },
  {
    id: 1,
    researchGroupId: 7,
    name: 'Beta',
    lastOpenedAt: null,
  },
]

/**
 * The server's GLOBAL ordered Quick Access snapshot: deliberately
 * NOT in id, name, or lastOpenedAt order (null entries interleaved,
 * not last), spans MULTIPLE Research Groups, and carries SIX items
 * so any client-side re-sorting, filtering, or max-five truncation
 * would change the returned array.
 */
const serverGlobalQuickAccess: ApiProjectQuickAccessItem[] = [
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
    id: 9,
    researchGroupId: 11,
    name: 'Zeta',
    lastOpenedAt: null,
  },
  {
    id: 1,
    researchGroupId: 7,
    name: 'Beta',
    lastOpenedAt: null,
  },
]

const openResponse: ApiProjectNavigationOpen = {
  projectId: 42,
  lastOpenedAt: '2026-10-03T12:00:00Z',
}

describe('Project Quick Access client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()

    vi.mocked(apiGet).mockResolvedValue(serverQuickAccess)
    vi.mocked(apiPost).mockResolvedValue(openResponse)
  })

  describe('fetchProjectQuickAccess', () => {
    it('requests the canonical quick access endpoint', async () => {
      await fetchProjectQuickAccess(7)

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith(
        '/api/research-groups/7/project-quick-access/',
      )
    })

    it('returns the exact server array object in server order', async () => {
      const result = await fetchProjectQuickAccess(7)

      expect(result).toBe(serverQuickAccess)
      expect(result).toHaveLength(5)
      expect(result.map((item) => item.id)).toEqual([4, 2, 9, 5, 1])
      expect(result.map((item) => item.lastOpenedAt)).toEqual([
        '2026-09-01T08:00:00Z',
        '2026-10-01T08:00:00Z',
        null,
        '2026-09-15T08:00:00Z',
        null,
      ])
    })
  })

  describe('fetchGlobalProjectQuickAccess', () => {
    beforeEach(() => {
      vi.mocked(apiGet).mockResolvedValue(serverGlobalQuickAccess)
    })

    it('requests exactly the global quick access endpoint via GET', async () => {
      await fetchGlobalProjectQuickAccess()

      expect(apiGet).toHaveBeenCalledTimes(1)
      expect(apiGet).toHaveBeenCalledWith('/api/me/project-quick-access/')
    })

    it('never requests a per-Research-Group quick access endpoint', async () => {
      await fetchGlobalProjectQuickAccess()

      expect(apiGet).not.toHaveBeenCalledWith(
        expect.stringContaining('/api/research-groups/'),
      )
    })

    it('returns the exact server array object in server order', async () => {
      const result = await fetchGlobalProjectQuickAccess()

      expect(result).toBe(serverGlobalQuickAccess)
      expect(result).toHaveLength(6)
      expect(result.map((item) => item.id)).toEqual([4, 12, 2, 31, 9, 1])
      expect(result.map((item) => item.researchGroupId)).toEqual([
        7,
        3,
        7,
        3,
        11,
        7,
      ])
      expect(result.map((item) => item.lastOpenedAt)).toEqual([
        '2026-09-01T08:00:00Z',
        null,
        '2026-10-01T08:00:00Z',
        '2026-09-15T08:00:00Z',
        null,
        null,
      ])
    })

    it(
      'preserves null lastOpenedAt and multi-Research-Group items without sorting or truncation',
      async () => {
        const result = await fetchGlobalProjectQuickAccess()

        expect(new Set(result.map((item) => item.researchGroupId)).size).toBe(
          3,
        )
        expect(
          result.filter((item) => item.lastOpenedAt === null),
        ).toHaveLength(3)
        expect(result).toEqual(serverGlobalQuickAccess)
      },
    )

    it('coexists with the per-RG client: one call per endpoint, no fan-out', async () => {
      vi.mocked(apiGet)
        .mockResolvedValueOnce(serverGlobalQuickAccess)
        .mockResolvedValueOnce(serverQuickAccess)

      const [globalResult, perGroupResult] = await Promise.all([
        fetchGlobalProjectQuickAccess(),
        fetchProjectQuickAccess(7),
      ])

      expect(apiGet).toHaveBeenCalledTimes(2)
      expect(apiGet).toHaveBeenNthCalledWith(
        1,
        '/api/me/project-quick-access/',
      )
      expect(apiGet).toHaveBeenNthCalledWith(
        2,
        '/api/research-groups/7/project-quick-access/',
      )
      expect(globalResult).toBe(serverGlobalQuickAccess)
      expect(perGroupResult).toBe(serverQuickAccess)
    })
  })

  describe('recordProjectOpen', () => {
    it('POSTs the canonical Project open endpoint', async () => {
      await recordProjectOpen(42)

      expect(apiPost).toHaveBeenCalledTimes(1)
      expect(apiPost).toHaveBeenCalledWith('/api/me/projects/42/open/', {})
    })

    it('sends exactly an empty body — no timestamp or client field', async () => {
      await recordProjectOpen(42)

      const sent = vi.mocked(apiPost).mock.calls[0][1]
      expect(sent).toEqual({})
      expect(Object.keys(sent as object)).toEqual([])
    })

    it('returns the server confirmation unchanged', async () => {
      const result = await recordProjectOpen(42)

      expect(result).toBe(openResponse)
    })
  })

  describe('error propagation', () => {
    it('propagates a GET ApiError unchanged', async () => {
      const error = new ApiError(401, {
        detail: 'Authentication credentials were not provided.',
      })
      vi.mocked(apiGet).mockRejectedValue(error)

      await expect(fetchProjectQuickAccess(7)).rejects.toBe(error)
    })

    it('propagates a POST ApiError unchanged', async () => {
      const error = new ApiError(404, {
        error: 'Project not found.',
      })
      vi.mocked(apiPost).mockRejectedValue(error)

      await expect(recordProjectOpen(42)).rejects.toBe(error)
    })

    it('propagates a global GET ApiError unchanged', async () => {
      const error = new ApiError(401, {
        detail: 'Authentication credentials were not provided.',
      })
      vi.mocked(apiGet).mockRejectedValue(error)

      await expect(fetchGlobalProjectQuickAccess()).rejects.toBe(error)
    })
  })
})
