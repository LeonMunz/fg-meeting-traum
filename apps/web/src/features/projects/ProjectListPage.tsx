import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import {
  CreateProjectDialog,
  type CreateProjectInput,
} from './CreateProjectDialog'

type DemoProjectStatus = 'active' | 'paused' | 'completed'
type DemoProjectRole = 'owner' | 'member' | 'viewer'

type DemoProject = {
  id: string
  name: string
  description: string
  status: DemoProjectStatus
  role: DemoProjectRole
  memberCount: number
  memberInitials: string[]
  updatedLabel: string
}

const initialProjects: DemoProject[] = [
  {
    id: 'quantum-materials',
    name: 'Quantum Materials Study',
    description:
      'Experimental and computational research on topological quantum materials.',
    status: 'active',
    role: 'owner',
    memberCount: 5,
    memberInitials: ['LM', 'CS', 'AK'],
    updatedLabel: 'Updated today',
  },
  {
    id: 'ai-engineering',
    name: 'AI Engineering Lab',
    description:
      'Applied research on reliable AI systems, evaluation and research tooling.',
    status: 'active',
    role: 'member',
    memberCount: 8,
    memberInitials: ['JB', 'MS', 'LM'],
    updatedLabel: 'Updated yesterday',
  },
  {
    id: 'grant-proposal',
    name: 'Collaborative Grant Proposal',
    description:
      'Preparation of the next interdisciplinary funding proposal and work plan.',
    status: 'paused',
    role: 'viewer',
    memberCount: 4,
    memberInitials: ['NW', 'CS', 'TR'],
    updatedLabel: 'Updated Aug 8',
  },
  {
    id: 'cluster-upgrade',
    name: 'Research Cluster Upgrade',
    description:
      'Planning and documentation for the laboratory compute infrastructure refresh.',
    status: 'completed',
    role: 'member',
    memberCount: 3,
    memberInitials: ['AK', 'JB', 'LM'],
    updatedLabel: 'Updated Jul 29',
  },
]

const statusLabels: Record<DemoProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
}

const roleLabels: Record<DemoProjectRole, string> = {
  owner: 'Owner',
  member: 'Member',
  viewer: 'Viewer',
}

const roleIcons: Record<DemoProjectRole, string> = {
  owner: 'shield_person',
  member: 'person',
  viewer: 'visibility',
}

const statusDotStyles: Record<DemoProjectStatus, string> = {
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  completed: 'bg-outline',
}

type StatusFilter = 'all' | DemoProjectStatus

const filters: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
]

export function ProjectListPage() {
  const navigate = useNavigate()
  const location = useLocation()

  const [projects, setProjects] = useState<DemoProject[]>(initialProjects)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  const handleCreateProject = (input: CreateProjectInput) => {
    const newProject: DemoProject = {
      id: crypto.randomUUID(),
      name: input.name,
      description:
        input.description || 'No project description has been added yet.',
      status: input.status,
      role: 'owner',
      memberCount: 1,
      memberInitials: ['AD'],
      updatedLabel: 'Updated just now',
    }

    setProjects((currentProjects) => [newProject, ...currentProjects])
    setStatusFilter('all')
    setSearchQuery('')
  }

  const previewState =
    new URLSearchParams(location.search).get('preview')

  const isLoading = previewState === 'loading'
  const isError = previewState === 'error'
  const forceEmpty = previewState === 'empty'

  const hasActiveFilters =
    statusFilter !== 'all' || searchQuery.trim().length > 0

  const visibleProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const sourceProjects = forceEmpty ? [] : projects

    return sourceProjects.filter((project) => {
      const matchesStatus =
        statusFilter === 'all' || project.status === statusFilter

      const matchesSearch =
        query.length === 0 ||
        project.name.toLowerCase().includes(query) ||
        project.description.toLowerCase().includes(query)

      return matchesStatus && matchesSearch
    })
  }, [forceEmpty, projects, searchQuery, statusFilter])

  const projectCount = forceEmpty ? 0 : projects.length

  const clearFilters = () => {
    setStatusFilter('all')
    setSearchQuery('')
  }

  const clearPreviewState = () => {
    const params = new URLSearchParams(location.search)
    params.delete('preview')

    const search = params.toString()

    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
      },
      { replace: true },
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-on-surface">
            Projects
          </h1>

          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-on-surface-variant">
            Organize research work in separate project spaces with their own
            members, roles and lifecycle.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setCreateDialogOpen(true)}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
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
              const isActive = statusFilter === filter.value

              return (
                <button
                  key={filter.value}
                  type="button"
                  onClick={() => setStatusFilter(filter.value)}
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
          </div>

          <label className="relative block w-full md:max-w-xs">
            <span className="sr-only">Search projects</span>

            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-on-surface-variant">
              search
            </span>

            <input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search projects..."
              className="h-10 w-full rounded-lg border border-outline-variant bg-surface-container-lowest pl-10 pr-4 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/70 focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </label>
        </div>

        {isLoading ? (
          <ProjectListSkeleton />
        ) : isError ? (
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
              Something went wrong while loading your projects. Your current
              filters have not been changed.
            </p>

            <button
              type="button"
              onClick={clearPreviewState}
              className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest px-4 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-low"
            >
              <span className="material-symbols-outlined text-[18px]">
                refresh
              </span>
              Try again
            </button>
          </div>
        ) : visibleProjects.length > 0 ? (
          <div className="mt-4 overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest">
            <div className="hidden h-9 grid-cols-[minmax(360px,1fr)_120px_120px_180px_110px] items-center px-6 lg:grid">
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
                Members
              </div>

              <div className="text-[11px] font-normal text-on-surface-variant/75">
                Updated
              </div>
            </div>

            <div className="border-t border-outline-variant/40">
              {visibleProjects.map((project, index) => {
                const updatedLabel = project.updatedLabel.replace(
                  /^Updated\s+/,
                  '',
                )

                const visibleInitials = project.memberInitials.slice(0, 2)
                const hiddenMemberCount = Math.max(
                  project.memberCount - visibleInitials.length,
                  0,
                )

                return (
                  <article
                    key={project.id}
                    role="link"
                    tabIndex={0}
                    onClick={() =>
                      navigate(`/projects/${project.id}`, {
                        state: { project },
                      })
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' ||
                        event.key === ' '
                      ) {
                        event.preventDefault()
                        navigate(`/projects/${project.id}`, {
                          state: { project },
                        })
                      }
                    }}
                    className={[
                      'group grid cursor-pointer gap-4 px-5 py-3.5 transition-colors hover:bg-surface-container-low/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-6',
                      'lg:min-h-[68px] lg:grid-cols-[minmax(360px,1fr)_120px_120px_180px_110px] lg:items-center lg:gap-0',
                      index > 0
                        ? 'border-t border-outline-variant/25'
                        : '',
                    ].join(' ')}
                  >
                    <div className="min-w-0 pr-8">
                      <h2 className="truncate text-sm font-semibold text-on-surface">
                        {project.name}
                      </h2>

                      <p className="mt-1 truncate text-xs font-normal text-on-surface-variant">
                        {project.description}
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
                            statusDotStyles[project.status],
                          ].join(' ')}
                        />

                        <span>
                          {statusLabels[project.status]}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] text-on-surface-variant lg:hidden">
                        Role
                      </div>

                      <div className="flex items-center gap-1.5 text-xs font-normal text-on-surface-variant">
                        <span className="material-symbols-outlined text-[15px]">
                          {roleIcons[project.role]}
                        </span>

                        <span>{roleLabels[project.role]}</span>
                      </div>
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] text-on-surface-variant lg:hidden">
                        Members
                      </div>

                      <div className="flex min-w-0 items-center gap-2">
                        <div className="flex shrink-0 -space-x-1.5">
                          {visibleInitials.map((initials) => (
                            <div
                              key={initials}
                              className="flex h-[22px] w-[22px] items-center justify-center rounded-full border border-surface-container-lowest bg-surface-container-high text-[8px] font-semibold text-on-surface"
                            >
                              {initials}
                            </div>
                          ))}
                        </div>

                        <span className="truncate text-xs font-normal text-on-surface-variant">
                          {project.memberCount === 1
                            ? '1 member'
                            : hiddenMemberCount > 0
                              ? `+${hiddenMemberCount}`
                              : `${project.memberCount} members`}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-normal text-on-surface-variant">
                        {updatedLabel}
                      </span>

                      <span className="material-symbols-outlined translate-x-[-2px] text-[17px] text-on-surface-variant/40 opacity-0 transition group-hover:translate-x-0 group-hover:text-primary group-hover:opacity-100">
                        arrow_forward
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        ) : projectCount === 0 && !hasActiveFilters ? (
          <div className="mt-8 flex min-h-72 flex-col items-center justify-center rounded-xl border border-dashed border-outline-variant bg-surface-container-lowest px-6 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-fixed text-primary">
              <span className="material-symbols-outlined text-[23px]">
                create_new_folder
              </span>
            </div>

            <h2 className="mt-4 text-base font-semibold text-on-surface">
              No projects yet
            </h2>

            <p className="mt-1 max-w-md text-sm leading-6 text-on-surface-variant">
              Create your first project to organize work, members and project
              access in a separate workspace.
            </p>

            <button
              type="button"
              onClick={() => setCreateDialogOpen(true)}
              className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-primary/90"
            >
              <span className="material-symbols-outlined text-[18px]">
                add
              </span>
              Create project
            </button>
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
              No projects match your current search and status filters.
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
      <div className="hidden h-9 grid-cols-[minmax(360px,1fr)_120px_120px_180px_110px] items-center px-6 lg:grid">
        <div className="h-2.5 w-12 rounded bg-surface-container-low" />
        <div className="h-2.5 w-10 rounded bg-surface-container-low" />
        <div className="h-2.5 w-8 rounded bg-surface-container-low" />
        <div className="h-2.5 w-12 rounded bg-surface-container-low" />
        <div className="h-2.5 w-10 rounded bg-surface-container-low" />
      </div>

      <div className="border-t border-outline-variant/40">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className={[
              'grid animate-pulse gap-4 px-6 py-3.5',
              'lg:min-h-[68px] lg:grid-cols-[minmax(360px,1fr)_120px_120px_180px_110px] lg:items-center lg:gap-0',
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

            <div className="flex items-center gap-2">
              <div className="flex -space-x-1.5">
                <div className="h-[22px] w-[22px] rounded-full bg-surface-container-high" />
                <div className="h-[22px] w-[22px] rounded-full bg-surface-container-high" />
              </div>

              <div className="h-3 w-8 rounded bg-surface-container-low" />
            </div>

            <div className="h-3 w-16 rounded bg-surface-container-low" />
          </div>
        ))}
      </div>
    </div>
  )
}
