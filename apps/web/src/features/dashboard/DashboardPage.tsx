const attentionItems = [
  {
    label: 'Overdue',
    value: '3 Tasks',
    icon: 'warning',
    className: 'border-red-200',
    iconClassName: 'bg-red-100 text-red-700',
  },
  {
    label: 'Blocked',
    value: '2 Issues',
    icon: 'block',
    className: 'border-orange-200',
    iconClassName: 'bg-orange-100 text-orange-700',
  },
  {
    label: 'Missing Action',
    value: '1 Item',
    icon: 'assignment_ind',
    className: 'border-outline-variant',
    iconClassName: 'bg-surface-container-high text-on-surface-variant',
  },
]

const tasks = [
  {
    title: 'Draft Intro Section',
    project: 'Quantum Sim',
    status: 'In Progress',
    due: 'Today',
    urgent: true,
  },
  {
    title: 'Review Peer Feedback',
    project: 'Grant Proposal',
    status: 'To Do',
    due: 'Aug 16',
    urgent: false,
  },
  {
    title: 'Setup Lab Environment',
    project: 'Infrastructure',
    status: 'Blocked',
    due: 'Aug 18',
    urgent: false,
  },
]

const goals = [
  {
    title: 'Submit Paper',
    subtitle: 'Quantum Sim V2',
    progress: 78,
    color: '#3525cd',
  },
  {
    title: 'Improve Teaching',
    subtitle: 'AI Engineering',
    progress: 62,
    color: '#565e74',
  },
  {
    title: 'Lab Infrastructure',
    subtitle: 'Cluster Upgrade',
    progress: 41,
    color: '#7e3000',
  },
]

const agenda = [
  {
    time: '09:00',
    title: 'FG Weekly',
    meta: 'Meeting Room',
    icon: 'groups',
  },
  {
    time: '11:30',
    title: 'Student Mentoring',
    meta: 'Room 402',
    icon: 'location_on',
  },
  {
    time: '14:00',
    title: 'Deep Work: Paper',
    meta: '2 hours',
    icon: 'timer',
  },
]

export function DashboardPage() {
  return (
    <div className="mx-auto max-w-[1440px] p-10">
      <section>
        <p className="mb-1 text-sm text-on-surface-variant">
          Thursday, August 13
        </p>

        <h1 className="text-3xl font-semibold tracking-tight">
          Good afternoon, Leon.
        </h1>

        <div className="mt-6 grid grid-cols-4 gap-4">
          {attentionItems.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`flex items-start gap-3 rounded-xl border bg-surface-container-lowest p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${item.className}`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${item.iconClassName}`}
              >
                <span className="material-symbols-outlined text-[19px]">
                  {item.icon}
                </span>
              </div>

              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  {item.label}
                </div>

                <div className="mt-1 font-semibold">
                  {item.value}
                </div>
              </div>
            </button>
          ))}

          <button
            type="button"
            className="flex items-start gap-3 rounded-xl bg-primary-container p-4 text-left text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15">
              <span className="material-symbols-outlined text-[19px]">
                event
              </span>
            </div>

            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-white/75">
                NeurIPS Deadline
              </div>

              <div className="mt-1 font-semibold">
                In 6 Days
              </div>
            </div>
          </button>
        </div>
      </section>

      <div className="mt-7 grid grid-cols-12 gap-6">
        <div className="col-span-8 flex flex-col gap-6">
          <section className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
            <div className="flex items-center justify-between border-b border-outline-variant px-6 py-4">
              <div>
                <h2 className="font-semibold">My Work</h2>
                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Tasks requiring your attention
                </p>
              </div>

              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm font-medium text-primary transition hover:bg-primary-fixed"
              >
                View all
              </button>
            </div>

            <div className="overflow-hidden">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-outline-variant bg-surface-container-low">
                    <th className="w-12 px-4 py-2" />
                    <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      Title
                    </th>
                    <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      Project
                    </th>
                    <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      Status
                    </th>
                    <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      Due
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {tasks.map((task) => (
                    <tr
                      key={task.title}
                      className="border-b border-outline-variant last:border-b-0 hover:bg-surface-container-low/60"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="flex h-5 w-5 items-center justify-center rounded border border-outline-variant text-primary transition hover:border-primary"
                        >
                          <span className="material-symbols-outlined text-[14px] opacity-0 hover:opacity-100">
                            check
                          </span>
                        </button>
                      </td>

                      <td className="px-4 py-3 text-sm font-medium">
                        {task.title}
                      </td>

                      <td className="px-4 py-3 text-sm text-on-surface-variant">
                        {task.project}
                      </td>

                      <td className="px-4 py-3">
                        <span className="inline-flex rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-medium">
                          {task.status}
                        </span>
                      </td>

                      <td
                        className={`px-4 py-3 font-mono text-xs ${
                          task.urgent
                            ? 'font-semibold text-error'
                            : 'text-on-surface-variant'
                        }`}
                      >
                        {task.due}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="font-semibold">Active Goals</h2>
                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Current personal and group objectives
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {goals.map((goal) => (
                <button
                  key={goal.title}
                  type="button"
                  className="flex flex-col items-center rounded-xl border border-outline-variant bg-surface-container-lowest p-5 text-center shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div
                    className="relative flex h-20 w-20 items-center justify-center rounded-full"
                    style={{
                      background: `conic-gradient(${goal.color} ${goal.progress}%, #e5eeff ${goal.progress}% 100%)`,
                    }}
                  >
                    <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white">
                      <span className="font-semibold">
                        {goal.progress}%
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 text-sm font-semibold">
                    {goal.title}
                  </div>

                  <div className="mt-1 text-xs text-on-surface-variant">
                    {goal.subtitle}
                  </div>
                </button>
              ))}
            </div>
          </section>
        </div>

        <div className="col-span-4">
          <section className="h-full rounded-xl border border-outline-variant bg-surface-container-lowest shadow-sm">
            <div className="flex items-center justify-between border-b border-outline-variant px-6 py-4">
              <div>
                <h2 className="font-semibold">Today's Agenda</h2>
                <p className="mt-0.5 text-xs text-on-surface-variant">
                  Your schedule
                </p>
              </div>

              <span className="font-mono text-xs text-on-surface-variant">
                Aug 13
              </span>
            </div>

            <div className="p-5">
              <div className="relative ml-2 border-l-2 border-surface-container-high">
                {agenda.map((item, index) => (
                  <div
                    key={item.title}
                    className={index === agenda.length - 1 ? 'relative pl-7' : 'relative pb-7 pl-7'}
                  >
                    <div className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-white bg-primary" />

                    <div className="mb-1 font-mono text-xs font-medium text-primary">
                      {item.time}
                    </div>

                    <button
                      type="button"
                      className="w-full rounded-lg border border-outline-variant bg-surface p-3 text-left transition hover:border-primary/40 hover:shadow-sm"
                    >
                      <div className="text-sm font-semibold">
                        {item.title}
                      </div>

                      <div className="mt-1 flex items-center gap-1.5 text-xs text-on-surface-variant">
                        <span className="material-symbols-outlined text-[15px]">
                          {item.icon}
                        </span>

                        {item.meta}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}