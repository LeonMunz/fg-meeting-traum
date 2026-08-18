import {
  useEffect,
  useMemo,
} from 'react'
import { useSearchParams } from 'react-router'

import { useResearchGroup } from './useResearchGroup'

function parseGroupId(
  value: string | null,
): number | null {
  if (value == null) {
    return null
  }

  const parsed = Number(value)

  return Number.isInteger(parsed) &&
    parsed > 0
    ? parsed
    : null
}

export function useResearchGroupListScope() {
  const [
    searchParams,
    setSearchParams,
  ] = useSearchParams()

  const {
    groups,
    activeResearchGroupId,
    activeResearchGroup,
    loading,
    error,
    setActiveResearchGroupId,
  } = useResearchGroup()

  const rawGroupParam =
    searchParams.get('group')

  const hasGroupParam =
    rawGroupParam != null

  const requestedGroupId =
    parseGroupId(rawGroupParam)

  const routeResearchGroup =
    useMemo(
      () =>
        requestedGroupId == null
          ? null
          : (
              groups.find(
                (group) =>
                  group.id ===
                  requestedGroupId,
              ) ?? null
            ),
      [groups, requestedGroupId],
    )

  const invalidRouteScope =
    !loading &&
    hasGroupParam &&
    routeResearchGroup == null

  const scopedResearchGroup =
    hasGroupParam
      ? routeResearchGroup
      : activeResearchGroup

  useEffect(() => {
    if (loading) {
      return
    }

    if (routeResearchGroup) {
      if (
        routeResearchGroup.id !==
        activeResearchGroupId
      ) {
        setActiveResearchGroupId(
          routeResearchGroup.id,
        )
      }

      return
    }

    /*
     * A group explicitly present in the URL is authoritative.
     * Invalid or inaccessible group IDs must not silently fall
     * back to another Research Group.
     */
    if (hasGroupParam) {
      return
    }

    if (activeResearchGroupId != null) {
      const next =
        new URLSearchParams(
          searchParams,
        )

      next.set(
        'group',
        String(
          activeResearchGroupId,
        ),
      )

      setSearchParams(
        next,
        { replace: true },
      )
    }
  }, [
    activeResearchGroupId,
    hasGroupParam,
    loading,
    routeResearchGroup,
    searchParams,
    setActiveResearchGroupId,
    setSearchParams,
  ])

  return {
    activeResearchGroupId:
      scopedResearchGroup?.id ??
      null,
    activeResearchGroup:
      scopedResearchGroup,
    loading,
    error:
      error ??
      (
        invalidRouteScope
          ? 'Research group is not available.'
          : null
      ),
  }
}
