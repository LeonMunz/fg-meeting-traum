// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, apiGetFile } from './client'

const URL = '/api/meeting-series/7/agenda-export.json'

/**
 * A minimal fetch Response stand-in for a successful file download.
 * The exact Blob instance the mock returns is tracked so tests can
 * prove the client hands it back unmodified.
 */
function successResponse(body: string, filename?: string | null) {
  const blobInstance = new Blob([body], { type: 'application/json' })
  const contentDisposition =
    filename == null ? null : `attachment; filename="${filename}"`
  const jsonSpy = vi.fn().mockRejectedValue(
    new Error('success body must never be parsed as JSON'),
  )
  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-disposition'
          ? contentDisposition
          : null,
    },
    blob: vi.fn().mockResolvedValue(blobInstance),
    json: jsonSpy,
  }
  return { response, blobInstance, jsonSpy }
}

function errorResponse(status: number, jsonImpl: () => Promise<unknown>) {
  return {
    ok: false,
    status,
    json: jsonImpl,
  }
}

describe('apiGetFile (authenticated GET file boundary)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('issues one authenticated same-origin GET with an Accept header', async () => {
    const { response } = successResponse(
      '{}',
      'weekly-sync.json',
    )
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)

    await apiGetFile(URL)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(URL, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
  })

  it('preserves the successful body byte-for-byte as a Blob and does not parse it', async () => {
    const payload = '{"schemaVersion":1,"sections":[]}\n'
    const { response, blobInstance, jsonSpy } = successResponse(
      payload,
      'weekly-sync.json',
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await apiGetFile(URL)

    // The exact Blob returned by the response is handed back — the
    // server-produced bytes are never parsed or reserialized.
    expect(result.blob).toBe(blobInstance)
    expect(await result.blob.text()).toBe(
      '{"schemaVersion":1,"sections":[]}\n',
    )
    expect(jsonSpy).not.toHaveBeenCalled()
  })

  it('exposes the server-provided attachment filename from Content-Disposition', async () => {
    const { response } = successResponse(
      '{}',
      'weekly-sync.json',
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await apiGetFile(URL)

    expect(result.filename).toBe('weekly-sync.json')
  })

  it('returns a null filename when the header is absent', async () => {
    const { response } = successResponse(
      '{}',
      null,
    )
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))

    const result = await apiGetFile(URL)

    expect(result.filename).toBeNull()
  })

  it('converts a non-2xx JSON error into an ApiError with the parsed detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(404, async () => ({
          error: 'Meeting series not found',
        })),
      ),
    )

    const error = await apiGetFile(URL).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(404)
    expect(error.detail).toEqual({ error: 'Meeting series not found' })
  })

  it('falls back to a null detail when a non-2xx error body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(500, async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        }),
      ),
    )

    const error = await apiGetFile(URL).catch((e) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(500)
    expect(error.detail).toBeNull()
  })
})
