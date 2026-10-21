import {
  useEffect,
  useMemo,
} from 'react'
import {
  useParams,
  useSearchParams,
} from 'react-router'

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

/**
 * Resolve the Research Group scope of the group-bound list
 * surfaces (Projects list, Meetings list, placeholder pages).
 *
 * Scope priority — the first matching source is authoritative,
 * later sources never override it:
 *
 * 1. Research Group workspace route (`/groups/:groupId/...`):
 *    the `:groupId` path parameter decides the scope. A
 *    `?group=` query parameter on the same URL is ignored and
 *    can never override the workspace context.
 * 2. Global list route with an explicit `?group=` parameter
 *    (`/projects?group=<id>`, `/meetings?group=<id>`): the query
 *    parameter decides the scope (legacy entry, kept functional
 *    during the workspace migration).
 * 3. Global list route without an explicit group parameter: the
 *    provider's active Research Group applies, and the URL is
 *    normalized to `?group=<active id>` (existing behavior).
 *
 * An invalid or inaccessible scope — an unparseable, unknown, or
 * not currently accessible group ID — resolves to NO scope: the
 * hook reports the unavailable-group error, and no other Research
 * Group is substituted. Nothing is fetched under a different
 * group, the active provider group is never switched, no
 * navigation happens, and no `?group=` parameter is added.
 *
 * When the authoritative scope is a valid, accessible Research
 * Group, the provider's active group is synchronized with it
 * (guarded so an already-active group is not re-set). All other
 * query parameters (e.g. the Meetings `tab`) are preserved
 * untouched on workspace routes.
 */
export function useResearchGroupListScope() {
  const [
    searchParams,
    setSearchParams,
  ] = useSearchParams()

  const params = useParams()

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

  /*
   * Workspace scope: present exactly when the current route
   * provides a `:groupId` path parameter (Research Group
   * workspace route).
   */
  const rawPathGroupId =
    params.groupId ?? null

  const hasPathScope =
    rawPathGroupId != null

  const requestedPathGroupId =
    parseGroupId(rawPathGroupId)

  const routeResearchGroup =
    useMemo(
      () => {
        if (hasPathScope) {
          /*
           * The path parameter is authoritative: the
           * `?group=` query parameter is deliberately not
           * consulted as a fallback.
           */
          return requestedPathGroupId == null
            ? null
            : (
                groups.find(
                  (group) =>
                    group.id ===
                    requestedPathGroupId,
                ) ?? null
              )
        }

        if (!hasGroupParam) {
          return null
        }

        return requestedGroupId == null
          ? null
          : (
              groups.find(
                (group) =>
                  group.id ===
                  requestedGroupId,
              ) ?? null
            )
      },
      [
        groups,
        hasGroupParam,
        hasPathScope,
        requestedGroupId,
        requestedPathGroupId,
      ],
    )

  /*
   * An explicitly stated route scope — workspace path parameter
   * or `?group=` — is authoritative in both directions: it
   * resolves to a group or to the unavailable-group error, and
   * it suppresses the provider fallback AND the URL
   * normalization.
   */
  const hasRouteScope =
    hasPathScope || hasGroupParam

  const invalidRouteScope =
    !loading &&
    hasRouteScope &&
    routeResearchGroup == null

  const scopedResearchGroup =
    hasRouteScope
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
     * A group explicitly present in the URL (workspace path
     * parameter or `?group=`) is authoritative. Invalid or
     * inaccessible group IDs must not silently fall back to
     * another Research Group or normalize the URL.
     */
    if (hasRouteScope) {
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
    hasRouteScope,
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
