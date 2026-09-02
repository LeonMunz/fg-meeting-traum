import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from './client'

import type {
  ApiAddMeetingParticipantInput,
  ApiCreateMeetingFromSeriesInput,
  ApiCreateMeetingInput,
  ApiCreateMeetingItemInput,
  ApiCreateMeetingSeriesInput,
  ApiCreateMeetingSeriesSectionInput,
  ApiCreateMeetingWorkItemInput,
  ApiMeeting,
  ApiMeetingItem,
  ApiMeetingParticipant,
  ApiMeetingSection,
  ApiMeetingSeries,
  ApiMeetingSeriesSection,
  ApiCreateMeetingSectionInput,
  ApiReorderMeetingSectionsInput,
  ApiReorderMeetingSeriesSectionsInput,
  ApiUpdateMeetingInput,
  ApiUpdateMeetingItemInput,
  ApiUpdateMeetingSectionInput,
  ApiUpdateMeetingSeriesInput,
  ApiUpdateMeetingSeriesSectionInput,
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

export async function startMeeting(
  meetingId: number,
): Promise<ApiMeeting> {
  return apiPost<ApiMeeting>(
    `/api/meetings/${meetingId}/start`,
    {},
  )
}

export async function endMeeting(
  meetingId: number,
): Promise<ApiMeeting> {
  return apiPost<ApiMeeting>(
    `/api/meetings/${meetingId}/end`,
    {},
  )
}

export async function reopenMeeting(
  meetingId: number,
): Promise<ApiMeeting> {
  return apiPost<ApiMeeting>(
    `/api/meetings/${meetingId}/reopen`,
    {},
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

/* ── Meeting Series ────────────────────────────────────────────── */

export async function listMeetingSeries(
  researchGroupId: number,
): Promise<ApiMeetingSeries[]> {
  return apiGet<ApiMeetingSeries[]>(
    `/api/research-groups/${researchGroupId}/meeting-series/`,
  )
}

export async function createMeetingSeries(
  researchGroupId: number,
  input: ApiCreateMeetingSeriesInput,
): Promise<ApiMeetingSeries> {
  return apiPost<ApiMeetingSeries>(
    `/api/research-groups/${researchGroupId}/meeting-series/`,
    input,
  )
}

export async function getMeetingSeries(
  seriesId: number,
): Promise<ApiMeetingSeries> {
  return apiGet<ApiMeetingSeries>(
    `/api/meeting-series/${seriesId}/`,
  )
}

export async function updateMeetingSeries(
  seriesId: number,
  input: ApiUpdateMeetingSeriesInput,
): Promise<ApiMeetingSeries> {
  return apiPatch<ApiMeetingSeries>(
    `/api/meeting-series/${seriesId}/`,
    input,
  )
}

/* ── Meeting Series Sections ───────────────────────────────────── */

export async function listMeetingSeriesSections(
  seriesId: number,
): Promise<ApiMeetingSeriesSection[]> {
  return apiGet<ApiMeetingSeriesSection[]>(
    `/api/meeting-series/${seriesId}/sections/`,
  )
}

export async function createMeetingSeriesSection(
  seriesId: number,
  input: ApiCreateMeetingSeriesSectionInput,
): Promise<ApiMeetingSeriesSection> {
  return apiPost<ApiMeetingSeriesSection>(
    `/api/meeting-series/${seriesId}/sections/`,
    input,
  )
}

export async function updateMeetingSeriesSection(
  sectionId: number,
  input: ApiUpdateMeetingSeriesSectionInput,
): Promise<ApiMeetingSeriesSection> {
  return apiPatch<ApiMeetingSeriesSection>(
    `/api/meeting-series-sections/${sectionId}/`,
    input,
  )
}

export async function reorderMeetingSeriesSections(
  seriesId: number,
  input: ApiReorderMeetingSeriesSectionsInput,
): Promise<ApiMeetingSeriesSection[]> {
  return apiPatch<ApiMeetingSeriesSection[]>(
    `/api/meeting-series/${seriesId}/sections/reorder/`,
    input,
  )
}

/* ── Meeting Occurrences from Series ───────────────────────────── */

export async function createMeetingFromSeries(
  seriesId: number,
  input: ApiCreateMeetingFromSeriesInput,
): Promise<ApiMeeting> {
  return apiPost<ApiMeeting>(
    `/api/meeting-series/${seriesId}/occurrences/`,
    input,
  )
}

/* ── Meeting Sections (occurrence structure) ───────────────────── */

export async function listMeetingSections(
  meetingId: number,
): Promise<ApiMeetingSection[]> {
  return apiGet<ApiMeetingSection[]>(
    `/api/meetings/${meetingId}/sections/`,
  )
}

export async function createMeetingSection(
  meetingId: number,
  input: ApiCreateMeetingSectionInput,
): Promise<ApiMeetingSection> {
  return apiPost<ApiMeetingSection>(
    `/api/meetings/${meetingId}/sections/`,
    input,
  )
}

export async function updateMeetingSection(
  sectionId: number,
  input: ApiUpdateMeetingSectionInput,
): Promise<ApiMeetingSection> {
  return apiPatch<ApiMeetingSection>(
    `/api/meeting-sections/${sectionId}/`,
    input,
  )
}

export async function reorderMeetingSections(
  meetingId: number,
  input: ApiReorderMeetingSectionsInput,
): Promise<ApiMeetingSection[]> {
  return apiPatch<ApiMeetingSection[]>(
    `/api/meetings/${meetingId}/sections/reorder/`,
    input,
  )
}
