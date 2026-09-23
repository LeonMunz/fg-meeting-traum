import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import {
  apiGet,
  apiPost,
  ApiError,
} from './client'
import {
  cancelMeetingItemFollowUp,
  createMeeting,
  createMeetingFromSeries,
  createMeetingRecurrence,
  listMeetingRecurrences,
  listPersonalMeetingRecurrenceOccurrences,
  getMeetingItemFollowUpTargets,
  markMeetingItemFollowUp,
  reopenMeetingItem,
  scheduleMeetingItemFollowUp,
  searchMeetingSeriesParticipantCandidates,
  searchStandaloneMeetingParticipantCandidates,
} from './meetings'

import type {
  ApiCancelMeetingItemFollowUpResult,
  ApiCreateMeetingRecurrenceInput,
  ApiMeetingRecurrence,
  ApiMeetingRecurrenceOccurrence,
  ApiMeetingRecurrenceOverview,
  ApiMeetingItem,
  ApiMeetingItemFollowUpSchedule,
  ApiMeetingItemFollowUpTargets,
} from './types'

vi.mock('./client', () => ({
  apiDelete: vi.fn(),
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

const schedule: ApiMeetingItemFollowUpSchedule = {
  id: 41,
  status: 'scheduled',
  sourceMeetingItemId: 17,
  sourceOutcome: 'follow_up',
  targetMeetingId: 23,
  targetMeetingTitle: 'Weekly Research Meeting',
  targetMeetingScheduledAt: '2026-09-16T09:00:00Z',
  targetMeetingSectionId: 29,
  targetMeetingSectionName: 'Agenda',
  targetMeetingItemId: 31,
  createdAt: '2026-09-09T10:00:00Z',
  updatedAt: '2026-09-09T10:00:00Z',
}

const targets: ApiMeetingItemFollowUpTargets = {
  recommendedMeetingId: 23,
  meetings: [
    {
      id: 23,
      title: 'Weekly Research Meeting',
      scheduledAt: '2026-09-16T09:00:00Z',
      seriesId: 5,
      recommendedSectionId: 29,
      sections: [
        {
          id: 29,
          name: 'Agenda',
          position: 0,
          sourceSeriesSectionId: 7,
        },
      ],
    },
  ],
}

const itemWithoutSchedule: ApiMeetingItem = {
  id: 17,
  meetingId: 11,
  meetingSectionId: 13,
  title: 'Review the experiment',
  contextNotes: '',
  position: 0,
  outcome: 'follow_up',
  followUpSchedule: null,
  workItemIds: [],
  notes: [],
  createdById: 2,
  createdAt: '2026-09-09T09:00:00Z',
  updatedAt: '2026-09-09T10:00:00Z',
}

describe('Meeting follow-up API client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  it('types MeetingItem schedule state as active or null', () => {
    const itemWithSchedule: ApiMeetingItem = {
      ...itemWithoutSchedule,
      followUpSchedule: schedule,
    }

    expect(itemWithoutSchedule.followUpSchedule).toBeNull()
    expect(itemWithSchedule.followUpSchedule).toEqual(schedule)
  })

  it('gets the committed follow-up target discovery endpoint', async () => {
    vi.mocked(apiGet).mockResolvedValue(targets)

    await expect(
      getMeetingItemFollowUpTargets(17),
    ).resolves.toEqual(targets)
    expect(apiGet).toHaveBeenCalledWith(
      '/api/meeting-items/17/follow-up-targets/',
    )
  })

  it('posts the exact scheduling payload and returns the schedule', async () => {
    vi.mocked(apiPost).mockResolvedValue(schedule)

    await expect(
      scheduleMeetingItemFollowUp(17, {
        targetMeetingId: 23,
        targetMeetingSectionId: 29,
      }),
    ).resolves.toEqual(schedule)
    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-items/17/schedule-follow-up',
      {
        targetMeetingId: 23,
        targetMeetingSectionId: 29,
      },
    )
  })

  it('keeps the legacy outcome mutation on its existing endpoint', async () => {
    vi.mocked(apiPost).mockResolvedValue(itemWithoutSchedule)

    await expect(markMeetingItemFollowUp(17)).resolves.toEqual(
      itemWithoutSchedule,
    )
    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-items/17/follow-up',
      {},
    )
  })

  it('posts to the focused MeetingItem reopen endpoint', async () => {
    const reopened = {
      ...itemWithoutSchedule,
      outcome: 'not_discussed' as const,
    }
    vi.mocked(apiPost).mockResolvedValue(reopened)

    await expect(reopenMeetingItem(17)).resolves.toEqual(reopened)
    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-items/17/reopen',
      {},
    )
  })
})

describe('Meeting creation participant API client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  it('searches standalone candidates with the exact create context', async () => {
    vi.mocked(apiGet).mockResolvedValue([])

    await searchStandaloneMeetingParticipantCandidates(3, {
      query: 'alex meyer',
      scope: 'project',
      projectId: 9,
    })

    expect(apiGet).toHaveBeenCalledWith(
      '/api/research-groups/3/meetings/participant-candidates/?q=alex+meyer&scope=project&projectId=9',
    )
  })

  it('searches candidates through the selected Meeting Template', async () => {
    vi.mocked(apiGet).mockResolvedValue([])

    await searchMeetingSeriesParticipantCandidates(7, 'chris')

    expect(apiGet).toHaveBeenCalledWith(
      '/api/meeting-series/7/participant-candidates/?q=chris',
    )
  })

  it('posts exact participant IDs on standalone creation', async () => {
    vi.mocked(apiPost).mockResolvedValue({})
    const input = {
      title: 'Weekly',
      scheduledAt: '2030-01-02T10:30:00.000Z',
      scope: 'group' as const,
      projectId: null,
      participantIds: [4, 8],
    }

    await createMeeting(3, input)

    expect(apiPost).toHaveBeenCalledWith(
      '/api/research-groups/3/meetings/',
      input,
    )
  })

  it('posts exact participant IDs on Template occurrence creation', async () => {
    vi.mocked(apiPost).mockResolvedValue({})
    const input = {
      title: 'Weekly',
      scheduledAt: '2030-01-02T10:30:00.000Z',
      participantIds: [4, 8],
    }

    await createMeetingFromSeries(7, input)

    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-series/7/occurrences/',
      input,
    )
  })
})

describe('Meeting follow-up cancel API client', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset()
  })

  const removedResult: ApiCancelMeetingItemFollowUpResult = {
    id: 41,
    status: 'cancelled',
    sourceMeetingItemId: 17,
    sourceOutcome: 'not_discussed',
    targetMeetingItemId: null,
    targetItemDisposition: 'removed',
  }

  const preservedResult: ApiCancelMeetingItemFollowUpResult = {
    id: 41,
    status: 'cancelled',
    sourceMeetingItemId: 17,
    sourceOutcome: 'not_discussed',
    targetMeetingItemId: 31,
    targetItemDisposition: 'preserved',
  }

  it('posts the focused cancel endpoint by FollowUp ID', async () => {
    vi.mocked(apiPost).mockResolvedValue(removedResult)

    await expect(cancelMeetingItemFollowUp(41)).resolves.toEqual(
      removedResult,
    )
    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-item-follow-ups/41/cancel',
      {},
    )
  })

  it('parses a removed disposition response', async () => {
    vi.mocked(apiPost).mockResolvedValue(removedResult)

    const result = await cancelMeetingItemFollowUp(41)

    expect(result.targetMeetingItemId).toBeNull()
    expect(result.targetItemDisposition).toBe('removed')
  })

  it('parses a preserved disposition response', async () => {
    vi.mocked(apiPost).mockResolvedValue(preservedResult)

    const result = await cancelMeetingItemFollowUp(41)

    expect(result.targetMeetingItemId).toBe(31)
    expect(result.targetItemDisposition).toBe('preserved')
  })

  it('surfaces client ApiError on failure', async () => {
    const error = new ApiError(403, { error: 'denied' })
    vi.mocked(apiPost).mockRejectedValue(error)

    await expect(cancelMeetingItemFollowUp(41)).rejects.toThrow(
      'API error 403',
    )
    await expect(cancelMeetingItemFollowUp(41)).rejects.toEqual(error)
  })
})

describe('Meeting recurrence API client', () => {
  beforeEach(() => {
    vi.mocked(apiPost).mockReset()
  })

  it('posts the recurrence rule to the dedicated creation endpoint', async () => {
    const input: ApiCreateMeetingRecurrenceInput = {
      meetingSeriesId: 7,
      title: 'Weekly Sync',
      frequency: 'weekly',
      interval: 1,
      weekdays: [0],
      startDate: '2030-01-07',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
    }
    const created: ApiMeetingRecurrence = {
      id: 500,
      title: 'Weekly Sync',
      meetingSeriesId: 7,
      researchGroupId: 3,
      scope: 'group',
      projectId: null,
      frequency: 'weekly',
      interval: 1,
      weekdays: [0],
      startDate: '2030-01-07',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      endDate: null,
      count: null,
    }
    vi.mocked(apiPost).mockResolvedValue(created)

    await expect(createMeetingRecurrence(input)).resolves.toEqual(
      created,
    )
    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-recurrences/',
      input,
    )
  })

  it('keeps weekdays as backend ISO integers in the request', async () => {
    vi.mocked(apiPost).mockResolvedValue(
      {} as ApiMeetingRecurrence,
    )

    await createMeetingRecurrence({
      meetingSeriesId: 7,
      title: 'Monday + Sunday',
      frequency: 'weekly',
      interval: 1,
      weekdays: [0, 6],
      startDate: '2030-01-07',
      localTime: '09:00',
      timezone: 'Europe/Berlin',
    })

    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-recurrences/',
      expect.objectContaining({
        frequency: 'weekly',
        interval: 1,
        weekdays: [0, 6],
      }),
    )
  })

  it('posts the optional participantIds on the same creation request', async () => {
    vi.mocked(apiPost).mockResolvedValue(
      {} as ApiMeetingRecurrence,
    )

    await createMeetingRecurrence({
      meetingSeriesId: 7,
      title: 'Weekly Sync',
      frequency: 'weekly',
      interval: 1,
      weekdays: [1],
      startDate: '2030-01-07',
      localTime: '10:30',
      timezone: 'Europe/Berlin',
      participantIds: [12, 34],
    })

    expect(apiPost).toHaveBeenCalledWith(
      '/api/meeting-recurrences/',
      expect.objectContaining({ participantIds: [12, 34] }),
    )
  })
})

describe('Meeting recurrence Series overview API client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  const creator = {
    id: 2,
    username: 'leo',
    firstName: 'Leon',
    lastName: 'Munz',
  }

  // A group-scoped, open-ended, ACTIVE series: null projectId, null
  // endDate/count, and a non-null next occurrence.
  const activeSeries: ApiMeetingRecurrenceOverview = {
    id: 500,
    title: 'Weekly Sync',
    meetingSeriesId: 7,
    researchGroupId: 3,
    scope: 'group',
    projectId: null,
    frequency: 'weekly',
    interval: 1,
    weekdays: [0],
    startDate: '2030-01-07',
    localTime: '10:30',
    timezone: 'Europe/Berlin',
    endDate: null,
    count: null,
    creator,
    peopleCount: 4,
    status: 'active',
    nextOccurrenceScheduledAt: '2026-09-29T08:30:00Z',
  }

  it('reads the window-free Series overview through a GET — no from/to window', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    await expect(listMeetingRecurrences()).resolves.toEqual([activeSeries])

    // A read against the collection endpoint with NO occurrence-window
    // parameters — personal relevance/scoping is backend-owned, and the
    // client issues no materializing write.
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/api/meeting-recurrences/')
    expect(apiGet).not.toHaveBeenCalledWith(
      expect.stringContaining('from='),
    )
    expect(apiGet).not.toHaveBeenCalledWith(
      expect.stringContaining('to='),
    )
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('preserves one backend object as one frontend Series record', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const result = await listMeetingRecurrences()

    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(activeSeries)
  })

  it('preserves the structured recurrence fields verbatim', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.id).toBe(500)
    expect(record.title).toBe('Weekly Sync')
    expect(record.meetingSeriesId).toBe(7)
    expect(record.researchGroupId).toBe(3)
    expect(record.scope).toBe('group')
    expect(record.frequency).toBe('weekly')
    expect(record.interval).toBe(1)
    expect(record.weekdays).toEqual([0])
    expect(record.startDate).toBe('2030-01-07')
    expect(record.localTime).toBe('10:30')
    expect(record.timezone).toBe('Europe/Berlin')
  })

  it('preserves the canonical minimal creator summary', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.creator).toEqual(creator)
  })

  it('preserves peopleCount', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.peopleCount).toBe(4)
  })

  it('preserves status: active with a non-null next occurrence', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.status).toBe('active')
    expect(record.nextOccurrenceScheduledAt).toBe('2026-09-29T08:30:00Z')
  })

  it('preserves status: ended with a null next occurrence', async () => {
    const endedSeries: ApiMeetingRecurrenceOverview = {
      ...activeSeries,
      id: 501,
      meetingSeriesId: 8,
      scope: 'project',
      projectId: 14,
      creator: {
        id: 5,
        username: 'sam',
        firstName: 'Sam',
        lastName: 'Kim',
      },
      peopleCount: 1,
      status: 'ended',
      nextOccurrenceScheduledAt: null,
    }
    vi.mocked(apiGet).mockResolvedValue([endedSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.status).toBe('ended')
    expect(record.nextOccurrenceScheduledAt).toBeNull()
  })

  it('preserves the nullable Project / end / count fields when set', async () => {
    const projectSeries: ApiMeetingRecurrenceOverview = {
      ...activeSeries,
      id: 502,
      scope: 'project',
      projectId: 21,
      meetingSeriesId: 9,
      endDate: '2026-11-30',
      count: 12,
    }
    vi.mocked(apiGet).mockResolvedValue([projectSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.scope).toBe('project')
    expect(record.projectId).toBe(21)
    expect(record.meetingSeriesId).toBe(9)
    expect(record.endDate).toBe('2026-11-30')
    expect(record.count).toBe(12)
  })

  it('preserves the nullable Project / end / count fields when null', async () => {
    vi.mocked(apiGet).mockResolvedValue([activeSeries])

    const [record] = await listMeetingRecurrences()

    expect(record.scope).toBe('group')
    expect(record.projectId).toBeNull()
    expect(record.endDate).toBeNull()
    expect(record.count).toBeNull()
  })
})

describe('Personal recurring-occurrence feed API client', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset()
    vi.mocked(apiPost).mockReset()
  })

  it('reads the bounded feed through a GET — never a materializing write', async () => {
    const feed: ApiMeetingRecurrenceOccurrence[] = [
      {
        occurrenceId: 'o-1',
        recurrenceId: 10,
        title: 'Weekly Sync',
        originalScheduledAt: '2026-09-29T10:00:00Z',
        scheduledAt: '2026-09-29T10:00:00Z',
        materialized: false,
        meetingId: null,
        meetingSeriesId: 7,
        researchGroupId: 1,
        projectId: null,
      },
    ]
    vi.mocked(apiGet).mockResolvedValue(feed)

    await expect(
      listPersonalMeetingRecurrenceOccurrences(
        '2026-09-23T00:00:00.000Z',
        '2026-11-04T00:00:00.000Z',
      ),
    ).resolves.toEqual(feed)

    // A GET read against the personal feed endpoint — the client issues no
    // materialization (no POST / unsafe write) and passes the window verbatim.
    expect(apiGet).toHaveBeenCalledWith(
      '/api/meeting-recurrences/occurrences/?from=2026-09-23T00%3A00%3A00.000Z&to=2026-11-04T00%3A00%3A00.000Z',
    )
    expect(apiPost).not.toHaveBeenCalled()
  })
})
