import { useState } from 'react'

import { ResearchGroupSelector } from './ResearchGroupSelector'

export function ResearchGroupPage() {
  const [selectedGroupId, setSelectedGroupId] = useState<number>()

  return (
    <div className="mx-auto max-w-[1440px] p-10">
      <h1 className="text-3xl font-semibold tracking-tight">
        Research Groups
      </h1>

      <p className="mt-1 text-sm text-on-surface-variant">
        Select a research group to work in.
      </p>

      <div className="mt-6 rounded-xl border border-outline-variant bg-surface-container-lowest p-6 shadow-sm">
        <div className="mb-4 text-sm font-medium text-on-surface">
          Your groups
        </div>
        <ResearchGroupSelector
          onSelect={setSelectedGroupId}
          selectedGroupId={selectedGroupId}
        />

        {selectedGroupId != null && (
          <div className="mt-6 rounded-lg bg-primary-container/30 px-4 py-3 text-sm text-on-primary-container">
            Active group selected.
          </div>
        )}
      </div>
    </div>
  )
}
