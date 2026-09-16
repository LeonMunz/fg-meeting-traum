import { beforeEach, describe, expect, it, vi } from 'vitest'

import { apiGet } from './client'
import { ACTIVITY_DOMAINS, listActivityFeed } from './activity'

vi.mock('./client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}))

describe('Activity feed query contract', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiGet).mockResolvedValue([])
  })

  it('requests the canonical compact page by default', async () => {
    await listActivityFeed()

    expect(apiGet).toHaveBeenCalledWith('/api/activity/?limit=20')
  })

  it('keeps the explicit limit in the query', async () => {
    await listActivityFeed({ limit: 50 })

    expect(apiGet).toHaveBeenCalledWith('/api/activity/?limit=50')
  })

  it('omits domains for the full default selection (all domains = absent parameter)', async () => {
    await listActivityFeed({
      domains: [...ACTIVITY_DOMAINS],
    })

    expect(apiGet).toHaveBeenCalledWith('/api/activity/?limit=20')
  })

  it('never sends an empty domains parameter', async () => {
    await listActivityFeed({ domains: [] })

    expect(apiGet).toHaveBeenCalledWith('/api/activity/?limit=20')
  })

  it('serializes a strict subset as OR-compatible comma values', async () => {
    await listActivityFeed({ domains: ['meeting'] })

    expect(apiGet).toHaveBeenCalledWith(
      '/api/activity/?limit=20&domains=meeting',
    )

    vi.mocked(apiGet).mockClear()

    await listActivityFeed({
      domains: ['work_item', 'meeting'],
    })

    expect(apiGet).toHaveBeenCalledWith(
      '/api/activity/?limit=20&domains=work_item,meeting',
    )
  })

  it('serializes in deterministic canonical order, not selection order', async () => {
    await listActivityFeed({
      domains: ['research_group', 'project', 'meeting'],
    })

    expect(apiGet).toHaveBeenCalledWith(
      '/api/activity/?limit=20&domains=meeting,project,research_group',
    )
  })

  it('ignores unknown domain values instead of sending them', async () => {
    await listActivityFeed({
      // @ts-expect-error - simulating a non-canonical value.
      domains: ['meeting', 'banana'],
    })

    expect(apiGet).toHaveBeenCalledWith(
      '/api/activity/?limit=20&domains=meeting',
    )
  })
})
