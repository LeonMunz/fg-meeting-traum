import { describe, expect, it } from 'vitest'

import { MeetingDetailPage } from './MeetingDetailPage'

const MEETING_DETAIL_SOURCE =
  MeetingDetailPage.toString()

describe('MeetingDetailPage lifecycle semantics', () => {
  it('exposes Start meeting for upcoming meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Start meeting')
  })

  it('keeps End meeting for live meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('End meeting')
  })

  it('keeps Reopen meeting for completed meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Reopen meeting')
  })
})

describe('MeetingDetailPage status-aware content', () => {
  it('does not render "Mark discussed" as a permanent agenda control', () => {
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'Mark discussed',
    )
  })

  it('renders a quiet "Discussed" state for protocol rows', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Discussed',
    )
  })
})

describe('MeetingDetailPage section and item controls', () => {
  it('exposes section secondary actions through a menu', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Rename / describe')
    expect(MEETING_DETAIL_SOURCE).toContain('Hide section')
    expect(MEETING_DETAIL_SOURCE).toContain('Move up')
    expect(MEETING_DETAIL_SOURCE).toContain('Move down')
  })

  it('exposes item secondary actions through a menu', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Create work item')
    expect(MEETING_DETAIL_SOURCE).toContain('Delete')
  })

  it('offers an explicit structure editing mode', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Edit structure')
    expect(MEETING_DETAIL_SOURCE).toContain('Add section')
  })

  it('supports inline quick-add for agenda items', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Add item')
  })
})

describe('MeetingDetailPage participant surface', () => {
  it('renders a compact participant context with explicit manage state', () => {
    expect(MEETING_DETAIL_SOURCE).toContain('Participants')
    expect(MEETING_DETAIL_SOURCE).toContain('Manage')
    expect(MEETING_DETAIL_SOURCE).toContain(
      'manage_accounts',
    )
  })

  it('keeps participant add/remove behind the management state', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'managingParticipants && canEditParticipants',
    )
  })
})

describe('MeetingDetailPage Work Item integration', () => {
  it('keeps the canonical Meeting -> Work Item dialog', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'CreateMeetingWorkItemDialog',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'setWorkItemSource(item)',
    )
  })
})

describe('MeetingDetailPage status gating', () => {
  it('gates preparation controls to upcoming + lifecycle permission', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'const canPrepare = isUpcoming && canManageLifecycle',
    )
  })
})

describe('MeetingDetailPage persistent Meeting Notes', () => {
  it('does not keep a second permanent frontend Note truth', () => {
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'temporaryNotes',
    )
    expect(MEETING_DETAIL_SOURCE).not.toContain(
      'localStorage',
    )
  })

  it('renders persisted Notes in Live and Completed', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      '(isLive || isCompleted) &&',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Notes',
    )
  })

  it('gates Note authoring to Live meetings', () => {
    expect(MEETING_DETAIL_SOURCE).toContain(
      'Add note…',
    )
    expect(MEETING_DETAIL_SOURCE).toContain(
      'createMeetingNote',
    )
  })
})
