import { useParams } from 'react-router'

import { useResearchGroup } from './useResearchGroup'

/**
 * Research Group Overview — the index area of the Research Group
 * workspace.
 *
 * The group header (name + description), the persistent section
 * tab bar, and the group-resolution states (loading / not-found /
 * error) are owned by the SHARED workspace layout
 * (`ResearchGroupWorkspaceLayout`), which resolves and
 * authorizes the group through the existing scope mechanism
 * BEFORE mounting this page through its `<Outlet />`. This page
 * therefore renders only its own content — no second
 * Research-Group heading, no second tab bar, no group fetch of
 * its own.
 *
 * The group identity is read from the existing provider context
 * (the same source the layout resolved), keyed by the route's
 * `:groupId` — no new state architecture.
 */
export function ResearchGroupOverviewPage() {
  const {
    groupId: rawGroupId,
  } = useParams<{
    groupId: string
  }>()

  const parsedGroupId =
    Number(rawGroupId)

  const groupId =
    Number.isInteger(parsedGroupId) &&
    parsedGroupId > 0
      ? parsedGroupId
      : null

  const { groups } =
    useResearchGroup()

  const group =
    groupId == null
      ? null
      : (
          groups.find(
            (item) =>
              item.id === groupId,
          ) ?? null
        )

  /*
   * Defensive: the workspace layout only mounts this
   * Outlet for a resolved, accessible group.
   */
  if (!group) {
    return null
  }

  return (
    <section className="max-w-xl">
      <p className="text-sm text-text-muted">
        This is the overview for this research group. Open its projects and meetings from here.
      </p>
    </section>
  )
}
