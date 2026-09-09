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
} from './client'
import {
  getMeetingItemFollowUpTargets,
  markMeetingItemFollowUp,
  scheduleMeetingItemFollowUp,
} from './meetings'

import type {
  ApiMeetingItem,
  ApiMeetingItemFollowUpSchedule,
  ApiMeetingItemFollowUpTargets,
} from './types'

vi.mock('./client', () => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiPost: vi.fn(),
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
})
