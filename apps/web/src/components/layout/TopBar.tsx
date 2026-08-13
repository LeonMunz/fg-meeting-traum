export function TopBar() {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-outline-variant bg-surface/95 px-6 backdrop-blur">
      <div className="relative w-full max-w-sm">
        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-on-surface-variant">
          search
        </span>

        <input
          type="search"
          placeholder="Search FG Workspace..."
          className="w-full rounded-lg border border-outline-variant bg-surface-container-lowest py-2 pl-10 pr-4 text-sm text-on-surface outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15"
        />
      </div>

      <div className="ml-6 flex items-center gap-1">
        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-primary"
          aria-label="Help"
        >
          <span className="material-symbols-outlined text-[21px]">
            help_outline
          </span>
        </button>

        <button
          type="button"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container-high hover:text-primary"
          aria-label="Create"
        >
          <span className="material-symbols-outlined text-[21px]">
            add_circle
          </span>
        </button>
      </div>
    </header>
  )
}