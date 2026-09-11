import type { Appearance } from './appearance'
import { useAppearance } from './useAppearance'

const appearanceOptions: Array<{
  value: Appearance
  label: string
  icon: string
}> = [
  {
    value: 'dark',
    label: 'Dark',
    icon: 'dark_mode',
  },
  {
    value: 'light',
    label: 'Light',
    icon: 'light_mode',
  },
]

export function AppearanceSettingsPage() {
  const { appearance, setAppearance } = useAppearance()

  return (
    <div className="mx-auto max-w-[960px] px-8 py-10">
      <h1 className="text-3xl font-semibold tracking-tight text-text">
        Settings
      </h1>

      <section
        aria-labelledby="appearance-heading"
        className="mt-8 rounded-xl border border-border-subtle bg-surface p-6 shadow-sm"
      >
        <div>
          <h2
            id="appearance-heading"
            className="text-lg font-semibold text-text"
          >
            Appearance
          </h2>

          <p className="mt-1 text-sm text-text-muted">
            Choose how FG Workspace looks on this device.
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label="Appearance"
          className="mt-5 inline-flex rounded-lg border border-border-default bg-surface-subtle p-1"
        >
          {appearanceOptions.map((option) => {
            const selected = appearance === option.value

            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setAppearance(option.value)}
                className={[
                  'flex min-w-28 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                  selected
                    ? 'bg-surface-muted text-text shadow-sm'
                    : 'text-text-muted hover:bg-surface-hover hover:text-text',
                ].join(' ')}
              >
                <span className="material-symbols-outlined text-[18px]">
                  {option.icon}
                </span>

                {option.label}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
