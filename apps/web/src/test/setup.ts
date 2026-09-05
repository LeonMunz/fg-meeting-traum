import { expect } from 'vitest'

import * as jestDom from '@testing-library/jest-dom/matchers'

// @testing-library/jest-dom v6 exports a matcher map; extend the
// Vitest expect explicitly (its auto-detection targets jest/globals).
for (const [name, matcher] of Object.entries(jestDom)) {
  expect.extend({ [name]: matcher as never })
}
