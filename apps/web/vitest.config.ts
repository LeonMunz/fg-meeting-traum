import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts (not to be touched by this
// slice) and deliberately minimal: the only thing under unit test right
// now is the Markdown <-> Tiptap-document round trip, which is pure
// logic with no DOM dependency, so no jsdom/happy-dom environment (and
// its dependency weight) is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
