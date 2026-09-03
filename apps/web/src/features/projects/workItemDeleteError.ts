import { ApiError } from '../../api/client'

// Shared Work Item deletion error mapping. Kept separate from the
// component file so workItemDelete.tsx stays component-only (Fast Refresh).
export function getDeleteErrorMessage(
  error: unknown,
  fallback: string,
): string {
  if (
    error instanceof ApiError &&
    error.detail &&
    typeof error.detail === 'object' &&
    'error' in error.detail
  ) {
    const detail = error.detail as { error?: unknown }

    if (typeof detail.error === 'string') {
      return detail.error
    }
  }

  return fallback
}
