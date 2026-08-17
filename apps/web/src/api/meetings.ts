import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiAddMeetingParticipantInput,
  ApiCreateMeetingInput,
  ApiCreateMeetingItemInput,
  ApiCreateMeetingWorkItemInput,
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiUpdateMeetingInput,
  ApiUpdateMeetingItemInput,
  ApiWorkItem,
} from './types'

export async function listMeetings(
  researchGroupId: number,
): Promise<ApiMeeting[]> {
  return apiGet<ApiMeeting[]>(
    `/api/research-groups/${researchGroupId}/meetings/`,
  )
}

export async function createMeeting(
  researchGroupId: number,
  input: ApiCreateMeetingInput,
): Promise<ApiMeeting> {
  return apiPost<ApiMeeting>(
    `/api/research-groups/${researchGroupId}/meetings/`,
    input,
  )
}

export async function getMeeting(
  meetingId: number,
): Promise<ApiMeeting> {
  return apiGet<ApiMeeting>(
    `/api/meetings/${meetingId}/`,
  )
}

export async function updateMeeting(
  meetingId: number,
  input: ApiUpdateMeetingInput,
): Promise<ApiMeeting> {
  return apiPatch<ApiMeeting>(
    `/api/meetings/${meetingId}/`,
    input,
  )
}

export async function listMeetingParticipants(
  meetingId: number,
): Promise<ApiMeetingParticipant[]> {
  return apiGet<ApiMeetingParticipant[]>(
    `/api/meetings/${meetingId}/participants/`,
  )
}

export async function addMeetingParticipant(
  meetingId: number,
  input: ApiAddMeetingParticipantInput,
): Promise<ApiMeetingParticipant> {
  return apiPost<ApiMeetingParticipant>(
    `/api/meetings/${meetingId}/participants/`,
    input,
  )
}

export async function removeMeetingParticipant(
  meetingId: number,
  participantId: number,
): Promise<void> {
  return apiDelete<void>(
    `/api/meetings/${meetingId}/participants/${participantId}/`,
  )
}

export async function listMeetingItems(
  meetingId: number,
): Promise<ApiMeetingItem[]> {
  return apiGet<ApiMeetingItem[]>(
    `/api/meetings/${meetingId}/items/`,
  )
}

export async function createMeetingItem(
  meetingId: number,
  input: ApiCreateMeetingItemInput,
): Promise<ApiMeetingItem> {
  return apiPost<ApiMeetingItem>(
    `/api/meetings/${meetingId}/items/`,
    input,
  )
}

export async function getMeetingItem(
  meetingItemId: number,
): Promise<ApiMeetingItem> {
  return apiGet<ApiMeetingItem>(
    `/api/meeting-items/${meetingItemId}/`,
  )
}

export async function updateMeetingItem(
  meetingItemId: number,
  input: ApiUpdateMeetingItemInput,
): Promise<ApiMeetingItem> {
  return apiPatch<ApiMeetingItem>(
    `/api/meeting-items/${meetingItemId}/`,
    input,
  )
}

export async function createWorkItemFromMeetingItem(
  meetingItemId: number,
  input: ApiCreateMeetingWorkItemInput,
): Promise<ApiWorkItem> {
  return apiPost<ApiWorkItem>(
    `/api/meeting-items/${meetingItemId}/work-items/`,
    input,
  )
}
