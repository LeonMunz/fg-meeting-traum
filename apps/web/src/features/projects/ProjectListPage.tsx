import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import {
  createProject,
  listProjects,
} from '../../api/projects'
import type {
  ApiProject,
  ApiProjectRole,
  ApiProjectStatus,
} from '../../api/types'
import { useResearchGroupListScope } from '../research-group/useResearchGroupListScope'
import {
  CreateProjectDialog,
  type CreateProjectInput,
} from './CreateProjectDialog'

const statusLabels: Record<ApiProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

const roleLabels: Record<ApiProjectRole, string> = {
  owner: 'Owner',
  member: 'Member',
  viewer: 'Viewer',
}

const roleIcons: Record<ApiProjectRole, string> = {
  owner: 'shield_person',
  member: 'person',
  viewer: 'visibility',
}

const statusDotStyles: Record<ApiProjectStatus, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  completed: 'bg-outline',
}

type StatusFilter = 'all' | ApiProjectStatus

const filters: Array<{
  value: StatusFilter
  label: string
}> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
]

function getApiErrorMessage(
  error: unknown,
  fallback: string,
) {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as {
      error?: unknown
    }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  if (error instanceof Error && error.message) {
    return error.message
  }

  return fallback
}

function formatUpdatedAt(value: string) {
  const updatedAt = new Date(value)

  if (Number.isNaN(updatedAt.getTime())) {
    return '—'
  }

  const now = new Date()

  const updatedDay = new Date(
    updatedAt.getFullYear(),
    updatedAt.getMonth(),
    updatedAt.getDate(),
  )

  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  )

  const diffDays = Math.round(
    (today.getTime() - updatedDay.getTime()) /
      86_400_000,
  )

  if (diffDays === 0) {
    return 'Today'
  }

  if (diffDays === 1) {
    return 'Yesterday'
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(updatedAt)
}

export function ProjectListPage() {
  const navigate = useNavigate()

  const {
    activeResearchGroupId,
    activeResearchGroup,
    loading: researchGroupsLoading,
    error: researchGroupsError,
  } = useResearchGroupListScope()

  const [projects, setProjects] = useState<ApiProject[]>([])
  const [projectsLoading, setProjectsLoading] =
    useState(false)
  const [projectsError, setProjectsError] =
    useState<string | null>(null)
  const [statusFilter, setStatusFilter] =
    useState<StatusFilter>('all')
  const [showArchived, setShowArchived] =
    useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [createDialogOpen, setCreateDialogOpen] =
    useState(false)

  const loadProjects = useCallback(async () => {
    if (activeResearchGroupId == null) {
      setProjects([])
      setProjectsLoading(false)
      return
    }

    setProjectsLoading(true)
    setProjectsError(null)

    try {
      const nextProjects = await listProjects(
        activeResearchGroupId,
      )

      setProjects(nextProjects)
    } catch (error) {
      setProjects([])
      setProjectsError(
        getApiErrorMessage(
          error,
          'Projects could not be loaded.',
        ),
      )
    } finally {
      setProjectsLoading(false)
    }
  }, [activeResearchGroupId])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const handleCreateProject = async (
    input: CreateProjectInput,
  ) => {
    if (activeResearchGroupId == null) {
      setProjectsError(
        'Select a research group before creating a project.',
      )
      return
    }

    setProjectsError(null)

    try {
      const project = await createProject(
        activeResearchGroupId,
        {
          name: input.name,
          description: input.description,
          status: input.status,
        },
      )

      setProjects((currentProjects) => [
        project,
        ...currentProjects.filter(
          (currentProject) =>
            currentProject.id !== project.id,
        ),
      ])

      setStatusFilter('all')
      setShowArchived(false)
      setSearchQuery('')
    } catch (error) {
      setProjectsError(
        getApiErrorMessage(
          error,
          'Project could not be created.',
        ),
      )
    }
  }

  const archivedProjectCount = useMemo(
    () =>
      projects.filter(
        (project) => project.archivedAt !== null,
      ).length,
    [projects],
  )

  const activeProjectCount =
    projects.length - archivedProjectCount

  const hasActiveFilters =
    statusFilter !== 'all' ||
    searchQuery.trim().length > 0

  const visibleProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    return projects.filter((project) => {
      const matchesArchiveView = showArchived
        ? project.archivedAt !== null
        : project.archivedAt === null

      const matchesStatus =
        statusFilter === 'all' ||
        project.status === statusFilter

      const matchesSearch =
        query.length === 0 ||
        project.name.toLowerCase().includes(query) ||
        project.description
          .toLowerCase()
          .includes(query)

      return (
        matchesArchiveView &&
        matchesStatus &&
        matchesSearch
      )
    })
  }, [
    projects,
    searchQuery,
    showArchived,
    statusFilter,
  ])

  const clearFilters = () => {
    setStatusFilter('all')
    setSearchQuery('')
  }

  const showCurrentProjects = () => {
    setShowArchived(false)
    setStatusFilter('all')
  }

  const showArchivedProjects = () => {
    setShowArchived(true)
    setStatusFilter('all')
  }

  const isLoading =
    researchGroupsLoading || projectsLoading

  const error =
    researchGroupsError || projectsError

  const hasResearchGroup =
    activeResearchGroupId != null

  return (
    <div className="w-full px-6 py-8 lg:px-8 lg:py-10 xl:px-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
            Projects
          </h1>

          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-on-surface-variant">
            {activeResearchGroup
              ? `Projects you can access in ${activeResearchGroup.name}.`
              : 'Organize research work in separate project spaces.'}
          </p>
        </div>

        <button
          type="button"
          disabled={!hasResearchGroup || isLoading}
          onClick={() => setCreateDialogOpen(true)}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <span className="material-symbols-outlined text-[19px]">
            add
          </span>
          New project
        </button>
      </header>

      <section className="mt-8">
        <div className="flex flex-col gap-4 border-b border-outline-variant pb-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1">
            {filters.map((filter) => {
              const isActive =
                !showArchived &&
                statusFilter === filter.value

              return (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => {
                    setShowArchived(false)
                    setStatusFilter(filter.value)
                  }}
                  className={[
                    'rounded-lg px-3 py-2 text-sm font-medium transition',
                    isActive
                      ? 'bg-secondary-container text-on-surface'
                      : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface',
                  ].join(' ')}
                >
                  {filter.label}
                </button>
              )
            })}

            <div
              aria-hidden="true"
              className="mx-1 h-5 w-px bg-outline-variant"
            />

            <button
              type="button"
              onClick={
                showArchived
                  ? showCurrentProjects
                  : showArchivedProjects
              }
              className={[
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition',
                showArchived
                  ? 'bg-secondary-container text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-[17px]"
              >
                archive
              </span>

              Archived

              {archivedProjectCount > 0 && (
                <span className="ml-0.5 text-[11px] opacity-70">
                  {archivedProjectCount}
                </span>
              )}
            </button>
          </div>

          <label className="relative block w-full md:max-w-xs">
            <span className="sr-only">
              Search projects
            </span>

            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              search
            </span>

            <input
              type="search"
              value={searchQuery}
              onChange={(event) =>
                setSearchQuery(event.target.value)
              }
              placeholder="Search projects..."
              className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest pl-10 pr-4 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/70 focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>
        </div>

        {isLoading ? (
          <ProjectListSkeleton />
        ) : error ? (
          <div
            role="alert"
            className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-xl border border-outline-variant bg-surface-container-lowest px-6 py-12 text-center shadow-sm"
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-error-container text-error">
              <span className="material-symbols-outlined text-[23px]">
                cloud_off
              </span>
            </div>

            <h2 className="mt-4 text-base font-semibold text-on-surface">
              Projects couldn't be loaded
            </h2>

            <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
              {error}
            </p>

            <button
              type="button"
              onClick={() => void loadProjects()}
              className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low"
            >
              <span className="material-symbols-outlined text-[18px]">
                refresh
              </span>
              Try again
            </button>
          </div>
        ) : !hasResearchGroup ? (
          <div className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
              <span className="material-symbols-outlined text-[23px]">
                groups
              </span>
            </div>

            <h2 className="mt-4 text-base font-semibold text-on-surface">
              No research group available
            </h2>

            <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
              You need access to a research group before
              projects can be created or opened.
            </p>
          </div>
        ) : visibleProjects.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="hidden h-9 grid-cols-[minmax(360px,1fr)_120px_120px_120px] items-center px-6 lg:grid">
              <div className="text-[11px] font-normal text-on-surface-variant/75">
                Project
              </div>

              <div className="text-[11px] font-normal text-on-surface-variant/75">
                Status
              </div>

              <div className="text-[11px] font-normal text-on-surface-variant/75">
                Role
              </div>

              <div className="text-[11px] font-normal text-on-surface-variant/75">
                Updated
              </div>
            </div>

            <div className="border-t border-outline-variant/40">
              {visibleProjects.map(
                (project, index) => (
                  <article
                    key={project.id}
                    role="link"
                    tabIndex={0}
                    onClick={() =>
                      navigate(
                        `/projects/${project.id}`,
                      )
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' ||
                        event.key === ' '
                      ) {
                        event.preventDefault()
                        navigate(
                          `/projects/${project.id}`,
                        )
                      }
                    }}
                    className={[
                      'group grid cursor-pointer gap-4 px-5 py-3.5 transition-colors hover:bg-surface-container-low/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-6',
                      'lg:min-h-[68px] lg:grid-cols-[minmax(360px,1fr)_120px_120px_120px] lg:items-center lg:gap-0',
                      index > 0
                        ? 'border-t border-outline-variant/25'
                        : '',
                    ].join(' ')}
                  >
                    <div className="min-w-0 pr-8">
                      <div className="flex min-w-0 items-center gap-2">
                        <h2 className="truncate text-sm font-semibold text-on-surface">
                          {project.name}
                        </h2>

                        {project.archivedAt !== null && (
                          <span
                            title="Archived project"
                            className="material-symbols-outlined shrink-0 text-[15px] text-on-surface-variant/65"
                          >
                            archive
                          </span>
                        )}
                      </div>

                      <p className="mt-1 truncate text-xs font-normal text-on-surface-variant">
                        {project.description ||
                          'No description'}
                      </p>
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] text-on-surface-variant lg:hidden">
                        Status
                      </div>

                      <div className="flex items-center gap-2 text-xs font-normal text-on-surface-variant">
                        <span
                          className={[
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            statusDotStyles[
                              project.status
                            ],
                          ].join(' ')}
                        />

                        <span>
                          {
                            statusLabels[
                              project.status
                            ]
                          }
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] text-on-surface-variant lg:hidden">
                        Role
                      </div>

                      <div className="flex items-center gap-1.5 text-xs font-normal text-on-surface-variant">
                        <span className="material-symbols-outlined text-[15px]">
                          {
                            roleIcons[
                              project.currentUserRole
                            ]
                          }
                        </span>

                        <span>
                          {
                            roleLabels[
                              project.currentUserRole
                            ]
                          }
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-normal text-on-surface-variant">
                        {formatUpdatedAt(
                          project.updatedAt,
                        )}
                      </span>

                      <span className="material-symbols-outlined translate-x-[-2px] text-[17px] text-on-surface-variant/40 opacity-0 transition group-hover:translate-x-0 group-hover:text-primary group-hover:opacity-100">
                        arrow_forward
                      </span>
                    </div>
                  </article>
                ),
              )}
            </div>
          </div>
        ) : activeProjectCount === 0 &&
          !showArchived &&
          !hasActiveFilters ? (
          <div className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-fixed text-primary">
              <span className="material-symbols-outlined text-[23px]">
                create_new_folder
              </span>
            </div>

            <h2 className="mt-4 text-base font-semibold text-on-surface">
              {archivedProjectCount > 0
                ? 'No current projects'
                : 'No projects yet'}
            </h2>

            <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
              {archivedProjectCount > 0
                ? 'Your archived projects are kept separately so the active workspace stays focused.'
                : 'Create your first project to organize work, members and project access in a separate workspace.'}
            </p>

            <div className="mt-5 flex items-center gap-3">
              {archivedProjectCount > 0 && (
                <button
                  type="button"
                  onClick={showArchivedProjects}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    archive
                  </span>
                  View archived
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  setCreateDialogOpen(true)
                }
                className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
              >
                <span className="material-symbols-outlined text-[18px]">
                  add
                </span>
                Create project
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-8 flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-container-high text-on-surface-variant">
              <span className="material-symbols-outlined text-[22px]">
                search_off
              </span>
            </div>

            <h2 className="mt-4 text-sm font-semibold text-on-surface">
              No matching projects
            </h2>

            <p className="mt-1 max-w-sm text-sm leading-6 text-on-surface-variant">
              No projects match your current search and
              status filters.
            </p>

            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold text-primary transition hover:bg-primary-fixed"
            >
              <span className="material-symbols-outlined text-[18px]">
                filter_alt_off
              </span>
              Clear filters
            </button>
          </div>
        )}
      </section>

      <CreateProjectDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreate={handleCreateProject}
      />
    </div>
  )
}

function ProjectListSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="mt-4 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest"
    >
      <div className="hidden h-9 grid-cols-[minmax(360px,1fr)_120px_120px_120px] items-center px-6 lg:grid">
        <div className="h-2.5 w-12 rounded bg-surface-container-low" />
        <div className="h-2.5 w-10 rounded bg-surface-container-low" />
        <div className="h-2.5 w-8 rounded bg-surface-container-low" />
        <div className="h-2.5 w-10 rounded bg-surface-container-low" />
      </div>

      <div className="border-t border-outline-variant/40">
        {Array.from({ length: 4 }).map(
          (_, index) => (
            <div
              key={index}
              className={[
                'grid animate-pulse gap-4 px-6 py-3.5',
                'lg:min-h-[68px] lg:grid-cols-[minmax(360px,1fr)_120px_120px_120px] lg:items-center lg:gap-0',
                index > 0
                  ? 'border-t border-outline-variant/25'
                  : '',
              ].join(' ')}
            >
              <div className="pr-8">
                <div className="h-3.5 w-52 rounded bg-surface-container-high" />
                <div className="mt-2 h-2.5 w-full max-w-md rounded bg-surface-container-low" />
              </div>

              <div className="h-3 w-14 rounded bg-surface-container-low" />

              <div className="h-3 w-14 rounded bg-surface-container-low" />

              <div className="h-3 w-16 rounded bg-surface-container-low" />
            </div>
          ),
        )}
      </div>
    </div>
  )
}
