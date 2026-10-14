import type { ApiWorkItem } from '../../api/types'

export const WORK_ITEM_CREATED_EVENT =
  'fg-workspace:work-item-created'

export type WorkItemCreatedDetail = ApiWorkItem

export function notifyWorkItemCreated(
  workItem: ApiWorkItem,
) {
  window.dispatchEvent(
    new CustomEvent<WorkItemCreatedDetail>(
      WORK_ITEM_CREATED_EVENT,
      {
        detail: workItem,
      },
    ),
  )
}
