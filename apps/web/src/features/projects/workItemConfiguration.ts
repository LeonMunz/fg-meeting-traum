export type WorkItemStatusDefinition = {
  id: string
  name: string
  icon: string
  completed: boolean
  isDefault?: boolean
}

export type WorkItemTypeDefinition = {
  id: string
  name: string
  icon: string
  isDefault?: boolean
}

export type WorkItemLabelDefinition = {
  id: string
  name: string
}

export const defaultWorkItemStatuses: WorkItemStatusDefinition[] = [
  {
    id: 'todo',
    name: 'To do',
    icon: 'radio_button_unchecked',
    completed: false,
    isDefault: true,
  },
  {
    id: 'in_progress',
    name: 'In progress',
    icon: 'pending',
    completed: false,
    isDefault: true,
  },
  {
    id: 'review',
    name: 'Review',
    icon: 'rate_review',
    completed: false,
    isDefault: true,
  },
  {
    id: 'done',
    name: 'Done',
    icon: 'check_circle',
    completed: true,
    isDefault: true,
  },
]

export const defaultWorkItemTypes: WorkItemTypeDefinition[] = [
  {
    id: 'epic',
    name: 'Epic',
    icon: 'account_tree',
    isDefault: true,
  },
  {
    id: 'milestone',
    name: 'Milestone',
    icon: 'flag',
    isDefault: true,
  },
  {
    id: 'deliverable',
    name: 'Deliverable',
    icon: 'inventory_2',
    isDefault: true,
  },
  {
    id: 'task',
    name: 'Task',
    icon: 'check_box_outline_blank',
    isDefault: true,
  },
]

export const defaultWorkItemLabels: WorkItemLabelDefinition[] = []
