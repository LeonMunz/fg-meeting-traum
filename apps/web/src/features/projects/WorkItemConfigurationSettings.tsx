import { useState } from 'react'

import type {
  WorkItemLabelDefinition,
  WorkItemStatusDefinition,
  WorkItemTypeDefinition,
} from './workItemConfiguration'

type UsageMap = Record<string, number>

type WorkItemConfigurationSettingsProps = {
  statuses: WorkItemStatusDefinition[]
  types: WorkItemTypeDefinition[]
  labels: WorkItemLabelDefinition[]
  statusUsage: UsageMap
  typeUsage: UsageMap
  readOnly: boolean
  onStatusesChange: (statuses: WorkItemStatusDefinition[]) => void
  onTypesChange: (types: WorkItemTypeDefinition[]) => void
  onLabelsChange: (labels: WorkItemLabelDefinition[]) => void
}

export function WorkItemConfigurationSettings({
  statuses,
  types,
  labels,
  statusUsage,
  typeUsage,
  readOnly,
  onStatusesChange,
  onTypesChange,
  onLabelsChange,
}: WorkItemConfigurationSettingsProps) {
  const [addingStatus, setAddingStatus] = useState(false)
  const [addingType, setAddingType] = useState(false)
  const [addingLabel, setAddingLabel] = useState(false)

  const [statusName, setStatusName] = useState('')
  const [statusCompleted, setStatusCompleted] = useState(false)
  const [typeName, setTypeName] = useState('')
  const [labelName, setLabelName] = useState('')

  const normalizedStatusName = statusName.trim()
  const normalizedTypeName = typeName.trim()
  const normalizedLabelName = labelName.trim()

  const statusDuplicate = statuses.some(
    (status) =>
      status.name.toLowerCase() === normalizedStatusName.toLowerCase(),
  )

  const typeDuplicate = types.some(
    (type) =>
      type.name.toLowerCase() === normalizedTypeName.toLowerCase(),
  )

  const labelDuplicate = labels.some(
    (label) =>
      label.name.toLowerCase() === normalizedLabelName.toLowerCase(),
  )

  const handleAddStatus = () => {
    if (!normalizedStatusName || statusDuplicate || readOnly) return

    onStatusesChange([
      ...statuses,
      {
        id: `status-${crypto.randomUUID()}`,
        name: normalizedStatusName,
        icon: statusCompleted
          ? 'check_circle'
          : 'radio_button_unchecked',
        completed: statusCompleted,
      },
    ])

    setStatusName('')
    setStatusCompleted(false)
    setAddingStatus(false)
  }

  const handleAddType = () => {
    if (!normalizedTypeName || typeDuplicate || readOnly) return

    onTypesChange([
      ...types,
      {
        id: `type-${crypto.randomUUID()}`,
        name: normalizedTypeName,
        icon: 'category',
      },
    ])

    setTypeName('')
    setAddingType(false)
  }

  const handleAddLabel = () => {
    if (!normalizedLabelName || labelDuplicate || readOnly) return

    onLabelsChange([
      ...labels,
      {
        id: `label-${crypto.randomUUID()}`,
        name: normalizedLabelName,
      },
    ])

    setLabelName('')
    setAddingLabel(false)
  }

  return (
    <div className="border-t border-outline-variant pt-7">
      <div>
        <h3 className="text-base font-semibold text-on-surface">
          Work item configuration
        </h3>

        <p className="mt-1 max-w-3xl text-xs leading-5 text-on-surface-variant">
          Configure the statuses, types and labels available to work items in
          this project.
        </p>
      </div>

      <div className="mt-6 space-y-8">
        <section>
          <ConfigurationHeader
            title="Statuses"
            description="Statuses define the columns and workflow of the project board."
          />

          <div className="mt-3 overflow-hidden rounded-xl border border-outline-variant">
            <div className="divide-y divide-outline-variant">
              {statuses.map((status) => {
                const usage = statusUsage[status.id] ?? 0
                const onlyStatus = statuses.length <= 1
                const canDelete = usage === 0 && !onlyStatus

                return (
                  <div
                    key={status.id}
                    className="flex items-center gap-4 px-4 py-3.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                      <span className="material-symbols-outlined text-[19px]">
                        {status.icon}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-on-surface">
                          {status.name}
                        </span>

                        {status.isDefault && (
                          <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold text-on-surface-variant">
                            Default
                          </span>
                        )}

                        <span
                          className={[
                            'rounded-full px-2 py-0.5 text-[10px] font-semibold',
                            status.completed
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-surface-container-low text-on-surface-variant',
                          ].join(' ')}
                        >
                          {status.completed ? 'Completed' : 'Open'}
                        </span>
                      </div>

                      <p className="mt-0.5 text-xs text-on-surface-variant">
                        {usage}{' '}
                        {usage === 1 ? 'work item' : 'work items'}
                      </p>
                    </div>

                    {!readOnly && (
                      <button
                        type="button"
                        disabled={!canDelete}
                        title={
                          usage > 0
                            ? 'This status is currently used by work items.'
                            : onlyStatus
                              ? 'A project must keep at least one status.'
                              : `Delete ${status.name}`
                        }
                        onClick={() =>
                          onStatusesChange(
                            statuses.filter(
                              (candidate) => candidate.id !== status.id,
                            ),
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-on-surface-variant transition hover:bg-error-container hover:text-error disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                      >
                        <span className="material-symbols-outlined text-[17px]">
                          delete_outline
                        </span>
                        Delete
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            {!readOnly && (
              <div className="border-t border-outline-variant bg-surface-container-low/35 px-4 py-3">
                {addingStatus ? (
                  <div>
                    <div className="flex items-center gap-3">
                      <input
                        autoFocus
                        value={statusName}
                        onChange={(event) =>
                          setStatusName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            handleAddStatus()
                          }
                        }}
                        placeholder="Status name..."
                        className="h-9 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                      />

                      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-on-surface-variant">
                        <input
                          type="checkbox"
                          checked={statusCompleted}
                          onChange={(event) =>
                            setStatusCompleted(event.target.checked)
                          }
                          className="h-4 w-4 rounded border-outline accent-primary"
                        />
                        Completed state
                      </label>

                      <button
                        type="button"
                        disabled={!normalizedStatusName || statusDuplicate}
                        onClick={handleAddStatus}
                        className="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Add
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setStatusName('')
                          setStatusCompleted(false)
                          setAddingStatus(false)
                        }}
                        className="h-9 rounded-lg px-3 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                      >
                        Cancel
                      </button>
                    </div>

                    {statusDuplicate && normalizedStatusName && (
                      <p className="mt-2 text-xs text-error">
                        A status with this name already exists.
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingStatus(true)}
                    className="inline-flex h-8 items-center gap-1.5 text-xs font-semibold text-primary"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      add
                    </span>
                    Add status
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        <section>
          <ConfigurationHeader
            title="Types"
            description="Types describe what kind of work item is being created."
          />

          <div className="mt-3 overflow-hidden rounded-xl border border-outline-variant">
            <div className="divide-y divide-outline-variant">
              {types.map((type) => {
                const usage = typeUsage[type.id] ?? 0
                const onlyType = types.length <= 1
                const canDelete = usage === 0 && !onlyType

                return (
                  <div
                    key={type.id}
                    className="flex items-center gap-4 px-4 py-3.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                      <span className="material-symbols-outlined text-[19px]">
                        {type.icon}
                      </span>
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-on-surface">
                          {type.name}
                        </span>

                        {type.isDefault && (
                          <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] font-semibold text-on-surface-variant">
                            Default
                          </span>
                        )}
                      </div>

                      <p className="mt-0.5 text-xs text-on-surface-variant">
                        {usage}{' '}
                        {usage === 1 ? 'work item' : 'work items'}
                      </p>
                    </div>

                    {!readOnly && (
                      <button
                        type="button"
                        disabled={!canDelete}
                        title={
                          usage > 0
                            ? 'This type is currently used by work items.'
                            : onlyType
                              ? 'A project must keep at least one work item type.'
                              : `Delete ${type.name}`
                        }
                        onClick={() =>
                          onTypesChange(
                            types.filter(
                              (candidate) => candidate.id !== type.id,
                            ),
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-on-surface-variant transition hover:bg-error-container hover:text-error disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                      >
                        <span className="material-symbols-outlined text-[17px]">
                          delete_outline
                        </span>
                        Delete
                      </button>
                    )}
                  </div>
                )
              })}
            </div>

            {!readOnly && (
              <div className="border-t border-outline-variant bg-surface-container-low/35 px-4 py-3">
                {addingType ? (
                  <div>
                    <div className="flex items-center gap-3">
                      <input
                        autoFocus
                        value={typeName}
                        onChange={(event) =>
                          setTypeName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            handleAddType()
                          }
                        }}
                        placeholder="Type name..."
                        className="h-9 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                      />

                      <button
                        type="button"
                        disabled={!normalizedTypeName || typeDuplicate}
                        onClick={handleAddType}
                        className="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Add
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setTypeName('')
                          setAddingType(false)
                        }}
                        className="h-9 rounded-lg px-3 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                      >
                        Cancel
                      </button>
                    </div>

                    {typeDuplicate && normalizedTypeName && (
                      <p className="mt-2 text-xs text-error">
                        A type with this name already exists.
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingType(true)}
                    className="inline-flex h-8 items-center gap-1.5 text-xs font-semibold text-primary"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      add
                    </span>
                    Add type
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        <section>
          <ConfigurationHeader
            title="Labels"
            description="Labels provide lightweight project-specific categorization."
          />

          <div className="mt-3 overflow-hidden rounded-xl border border-outline-variant">
            {labels.length > 0 ? (
              <div className="divide-y divide-outline-variant">
                {labels.map((label) => (
                  <div
                    key={label.id}
                    className="flex items-center gap-4 px-4 py-3.5"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
                      <span className="material-symbols-outlined text-[19px]">
                        label
                      </span>
                    </div>

                    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-on-surface">
                      {label.name}
                    </span>

                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() =>
                          onLabelsChange(
                            labels.filter(
                              (candidate) => candidate.id !== label.id,
                            ),
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-on-surface-variant transition hover:bg-error-container hover:text-error"
                      >
                        <span className="material-symbols-outlined text-[17px]">
                          delete_outline
                        </span>
                        Delete
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-3 px-4 py-5">
                <span className="material-symbols-outlined text-[19px] text-on-surface-variant">
                  label_off
                </span>

                <div>
                  <p className="text-sm font-medium text-on-surface">
                    No labels configured
                  </p>

                  <p className="mt-0.5 text-xs text-on-surface-variant">
                    Labels are optional and can be added when the project needs
                    additional categorization.
                  </p>
                </div>
              </div>
            )}

            {!readOnly && (
              <div className="border-t border-outline-variant bg-surface-container-low/35 px-4 py-3">
                {addingLabel ? (
                  <div>
                    <div className="flex items-center gap-3">
                      <input
                        autoFocus
                        value={labelName}
                        onChange={(event) =>
                          setLabelName(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            handleAddLabel()
                          }
                        }}
                        placeholder="Label name..."
                        className="h-9 min-w-0 flex-1 rounded-lg border border-outline-variant bg-surface-container-lowest px-3 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
                      />

                      <button
                        type="button"
                        disabled={!normalizedLabelName || labelDuplicate}
                        onClick={handleAddLabel}
                        className="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-white transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Add
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setLabelName('')
                          setAddingLabel(false)
                        }}
                        className="h-9 rounded-lg px-3 text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high"
                      >
                        Cancel
                      </button>
                    </div>

                    {labelDuplicate && normalizedLabelName && (
                      <p className="mt-2 text-xs text-error">
                        A label with this name already exists.
                      </p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setAddingLabel(true)}
                    className="inline-flex h-8 items-center gap-1.5 text-xs font-semibold text-primary"
                  >
                    <span className="material-symbols-outlined text-[17px]">
                      add
                    </span>
                    Add label
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {!readOnly && (
          <div className="flex items-start gap-2.5 rounded-lg bg-surface-container-low px-4 py-3">
            <span className="material-symbols-outlined mt-0.5 text-[17px] text-on-surface-variant">
              info
            </span>

            <p className="text-xs leading-5 text-on-surface-variant">
              Statuses and types currently used by work items cannot be deleted
              until those work items have been reassigned.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function ConfigurationHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-on-surface">
        {title}
      </h4>

      <p className="mt-0.5 text-xs text-on-surface-variant">
        {description}
      </p>
    </div>
  )
}
