import { defineConfig } from 'vitest/config'

// Deliberately separate from vite.config.ts (not to be touched by this
// config file, and deliberately minimal: current unit tests cover pure logic
// (Markdown/Tiptap round trip, work-item mapping) and TSX Meeting components,
// all running in the node environment, so no jsdom/happy-dom dependency is needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
