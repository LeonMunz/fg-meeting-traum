import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGet, apiPatch, apiPost, ApiError } from './client'
import {
  archivePersonalNote,
  createPersonalNote,
  getPersonalNote,
  listArchivedPersonalNotes,
  listPersonalNotes,
  restorePersonalNote,
  setPersonalNotePinned,
  updatePersonalNote,
} from './personal-notes'

import type { ApiPersonalNote } from './types'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
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

const activeNote: ApiPersonalNote = {
  id: 12,
  title: 'R&D sync',
  content: 'Prepare the a+b agenda.',
  pinned: true,
  archivedAt: null,
  createdAt: '2026-09-29T08:00:00Z',
  updatedAt: '2026-09-29T09:00:00Z',
}

const listFixture: ApiPersonalNote[] = [activeNote]

const archivedNote: ApiPersonalNote = {
  id: 13,
  title: 'Old capture',
  content: 'Keep for later.',
  pinned: false,
  archivedAt: '2026-09-28T16:30:00Z',
  createdAt: '2026-09-20T10:00:00Z',
  updatedAt: '2026-09-28T16:30:00Z',
}

describe('Personal Notes client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
    vi.mocked(apiPatch).mockReset()

    vi.mocked(apiGet).mockResolvedValue(listFixture)
    vi.mocked(apiPost).mockResolvedValue(activeNote)
    vi.mocked(apiPatch).mockResolvedValue(activeNote)
  })

  describe('active list and search', () => {
    it('requests the exact active collection URL without a query', async () => {
      await listPersonalNotes()

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/')
    })

    it('requests the exact collection URL for an explicit undefined query', async () => {
      await listPersonalNotes(undefined)

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/')
    })

    it('appends the search query to the exact collection URL', async () => {
      await listPersonalNotes('meeting notes')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/?q=meeting+notes')
    })

    it('trims leading and trailing whitespace before encoding', async () => {
      await listPersonalNotes('  meeting notes  ')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/?q=meeting+notes')
    })

    it('encodes spaces correctly', async () => {
      await listPersonalNotes('a b c')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/?q=a+b+c')
    })

    it('encodes ampersand characters correctly', async () => {
      await listPersonalNotes('R&D')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/?q=R%26D')
    })

    it('encodes plus characters correctly', async () => {
      await listPersonalNotes('a+b')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/?q=a%2Bb')
    })

    it('does not append q for an empty query', async () => {
      await listPersonalNotes('')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/')
    })

    it('does not append q for a whitespace-only query', async () => {
      await listPersonalNotes('   ')

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/')
    })
  })

  describe('archive list', () => {
    it('requests the exact archive collection URL', async () => {
      await listArchivedPersonalNotes()

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/archive/')
    })
  })

  describe('detail', () => {
    it('requests the exact note id URL', async () => {
      await getPersonalNote(12)

      expect(apiGet).toHaveBeenCalledWith('/api/me/notes/12/')
    })
  })

  describe('create', () => {
    it('posts the exact empty object payload for an explicit empty input', async () => {
      await createPersonalNote({})

      expect(apiPost).toHaveBeenCalledWith('/api/me/notes/', {})
    })

    it('posts the exact empty object payload without an argument', async () => {
      await createPersonalNote()

      expect(apiPost).toHaveBeenCalledWith('/api/me/notes/', {})
    })

    it('posts exactly the supplied title/content fields (no owner field)', async () => {
      await createPersonalNote({ title: 'Title', content: 'Body' })

      expect(apiPost).toHaveBeenCalledWith(
        '/api/me/notes/',
        { title: 'Title', content: 'Body' },
      )
    })
  })

  describe('update', () => {
    it('patches exactly the supplied title field', async () => {
      await updatePersonalNote(12, { title: 'New title' })

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/me/notes/12/',
        { title: 'New title' },
      )
    })

    it('patches exactly the supplied content field untransformed', async () => {
      await updatePersonalNote(12, { content: '**markdown** stays' })

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/me/notes/12/',
        { content: '**markdown** stays' },
      )
    })

    it('patches exactly the supplied title and content fields (no owner field)', async () => {
      await updatePersonalNote(12, { title: 'T', content: 'C' })

      expect(apiPatch).toHaveBeenCalledWith(
        '/api/me/notes/12/',
        { title: 'T', content: 'C' },
      )
    })
  })

  describe('pin actions', () => {
    it('posts { pinned: true } to the exact pin URL', async () => {
      await setPersonalNotePinned(12, true)

      expect(apiPost).toHaveBeenCalledWith(
        '/api/me/notes/12/pin/',
        { pinned: true },
      )
    })

    it('posts { pinned: false } to the exact pin URL', async () => {
      await setPersonalNotePinned(12, false)

      expect(apiPost).toHaveBeenCalledWith(
        '/api/me/notes/12/pin/',
        { pinned: false },
      )
    })
  })

  describe('archive / restore actions', () => {
    it('posts the exact empty object to the archive URL', async () => {
      await archivePersonalNote(12)

      expect(apiPost).toHaveBeenCalledWith(
        '/api/me/notes/12/archive/',
        {},
      )
    })

    it('posts the exact empty object to the restore URL', async () => {
      await restorePersonalNote(12)

      expect(apiPost).toHaveBeenCalledWith(
        '/api/me/notes/12/restore/',
        {},
      )
    })
  })

  describe('authoritative server responses', () => {
    it('returns the mocked active list response unchanged', async () => {
      const result = await listPersonalNotes()

      expect(result).toBe(listFixture)
    })

    it('returns the mocked search response unchanged', async () => {
      const result = await listPersonalNotes('meeting notes')

      expect(result).toBe(listFixture)
    })

    it('returns the mocked archive list response unchanged', async () => {
      const result = await listArchivedPersonalNotes()

      expect(result).toBe(listFixture)
    })

    it('returns the mocked detail response unchanged', async () => {
      vi.mocked(apiGet).mockResolvedValue(activeNote)

      const result = await getPersonalNote(12)

      expect(result).toBe(activeNote)
    })

    it('returns the mocked create response unchanged', async () => {
      const result = await createPersonalNote({})

      expect(result).toBe(activeNote)
    })

    it('returns the mocked update response unchanged', async () => {
      const result = await updatePersonalNote(12, { title: 'T' })

      expect(result).toBe(activeNote)
    })

    it('returns the mocked pin response unchanged', async () => {
      const result = await setPersonalNotePinned(12, true)

      expect(result).toBe(activeNote)
    })

    it('returns the mocked archive response unchanged', async () => {
      const result = await archivePersonalNote(12)

      expect(result).toBe(activeNote)
    })

    it('returns the mocked restore response unchanged', async () => {
      const result = await restorePersonalNote(12)

      expect(result).toBe(activeNote)
    })

    it('preserves archivedAt as null for active notes and as a string for archived notes', async () => {
      const both: ApiPersonalNote[] = [activeNote, archivedNote]
      vi.mocked(apiGet).mockResolvedValue(both)

      const result = await listPersonalNotes()

      expect(result).toEqual([activeNote, archivedNote])
      expect(result[0].archivedAt).toBeNull()
      expect(result[1].archivedAt).toBe('2026-09-28T16:30:00Z')
    })
  })

  describe('error propagation', () => {
    it('propagates a GET ApiError unchanged', async () => {
      const error = new ApiError(404, {
        error: 'Personal note not found.',
      })
      vi.mocked(apiGet).mockRejectedValue(error)

      await expect(getPersonalNote(99)).rejects.toBe(error)
    })

    it('propagates a POST ApiError unchanged', async () => {
      const error = new ApiError(400, { error: 'title: too long.' })
      vi.mocked(apiPost).mockRejectedValue(error)

      await expect(createPersonalNote()).rejects.toBe(error)
    })

    it('propagates a PATCH ApiError unchanged', async () => {
      const error = new ApiError(400, { error: 'pinned is not allowed.' })
      vi.mocked(apiPatch).mockRejectedValue(error)

      await expect(updatePersonalNote(12, { title: 'T' })).rejects.toBe(error)
    })
  })
})
