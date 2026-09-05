// Re-export the official Vitest typing for
// @testing-library/jest-dom matchers (see the package's
// types/vitest.d.ts), so the runtime extensions added in
// src/test/setup.ts are visible to the type checker.
import '@testing-library/jest-dom/vitest'
