/**
 * Personal Notes API client (frontend-only typed boundary).
 *
 * Covers the complete implemented Personal Notes backend contract:
 *   GET/POST /api/me/notes/
 *   GET /api/me/notes/archive/
 *   GET/PATCH/DELETE /api/me/notes/{noteId}/
 *   POST /api/me/notes/{noteId}/pin/ | /archive/ | /restore/
 *
 * The client is a thin typed layer over the existing `apiGet` /
 * `apiPost` / `apiPatch` / `apiDelete` transport: it performs no
 * client-side filtering, invents no default title/content, and
 * fabricates no Note — every returned Note is the authoritative
 * server response, and transport errors (ApiError) propagate
 * unchanged.
 */

import { apiDelete, apiGet, apiPatch, apiPost } from './client'

import type {
  ApiCreatePersonalNoteInput,
  ApiPersonalNote,
  ApiUpdatePersonalNoteInput,
} from './types'

/**
 * The current user's ACTIVE notes in the canonical backend ordering
 * (most recently updated first). With a non-empty (trimmed) query
 * this is the owner-scoped search `GET /api/me/notes/?q=<encoded>` —
 * matching stays backend-authoritative. An absent, empty, or
 * whitespace-only query requests the ordinary active list WITHOUT a
 * `q` parameter.
 */
export async function listPersonalNotes(
  query?: string,
): Promise<ApiPersonalNote[]> {
  const trimmed = (query ?? '').trim()

  if (trimmed === '') {
    return apiGet<ApiPersonalNote[]>('/api/me/notes/')
  }

  const params = new URLSearchParams({ q: trimmed })

  return apiGet<ApiPersonalNote[]>(`/api/me/notes/?${params.toString()}`)
}

/**
 * The current user's ARCHIVED notes in the canonical backend
 * ordering. The archive listing has no search parameter.
 */
export async function listArchivedPersonalNotes(): Promise<
  ApiPersonalNote[]
> {
  return apiGet<ApiPersonalNote[]>('/api/me/notes/archive/')
}

/** One of the current user's notes by id (active or archived). */
export async function getPersonalNote(noteId: number): Promise<ApiPersonalNote> {
  return apiGet<ApiPersonalNote>(`/api/me/notes/${noteId}/`)
}

/**
 * Capture-first create: an absent or empty input POSTs the empty
 * object to `/api/me/notes/`. The server stays authoritative for
 * empty title/content and ownership — the client never invents
 * defaults.
 */
export async function createPersonalNote(
  input: ApiCreatePersonalNoteInput = {},
): Promise<ApiPersonalNote> {
  return apiPost<ApiPersonalNote>('/api/me/notes/', input)
}

/**
 * Title/content-only partial update. Sends exactly the supplied
 * fields (no `pinned`, `archivedAt`, timestamps, or owner fields);
 * content is passed through untransformed. Returns the
 * authoritative server Note.
 */
export async function updatePersonalNote(
  noteId: number,
  input: ApiUpdatePersonalNoteInput,
): Promise<ApiPersonalNote> {
  return apiPatch<ApiPersonalNote>(`/api/me/notes/${noteId}/`, input)
}

/** Pin (`pinned: true`) or unpin (`pinned: false`) the note. */
export async function setPersonalNotePinned(
  noteId: number,
  pinned: boolean,
): Promise<ApiPersonalNote> {
  return apiPost<ApiPersonalNote>(`/api/me/notes/${noteId}/pin/`, { pinned })
}

/** Move the note to the archive (the server never deletes). */
export async function archivePersonalNote(
  noteId: number,
): Promise<ApiPersonalNote> {
  return apiPost<ApiPersonalNote>(`/api/me/notes/${noteId}/archive/`, {})
}

/** Restore an archived note (the same note id is kept). */
export async function restorePersonalNote(
  noteId: number,
): Promise<ApiPersonalNote> {
  return apiPost<ApiPersonalNote>(`/api/me/notes/${noteId}/restore/`, {})
}

/**
 * Permanently delete the note (active or archived). The server
 * physically removes the row — irreversible, no trash, no soft
 * delete. The success contract is `204 No Content` with no body,
 * so this resolves to `void` and fabricates no Note.
 */
export async function deletePersonalNote(
  noteId: number,
): Promise<void> {
  await apiDelete<void>(`/api/me/notes/${noteId}/`)
}
