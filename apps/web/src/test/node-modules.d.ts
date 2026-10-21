/**
 * Minimal ambient declarations for the node: modules used by unit
 * tests that read the filesystem (e.g. the Research Group Overview
 * theme contract reading `src/index.css` for the WCAG AA value
 * check).
 *
 * The app program is browser-only: tsconfig.app.json loads only
 * `vite/client` types, so the real @types/node package (present as a
 * transitive devDependency) is deliberately NOT in scope here. These
 * declarations keep the node-side test helpers type-checked without
 * widening the browser program with Node globals. Signatures are the
 * minimal slice of the real node APIs used — keep them in sync if a
 * test needs a different overload.
 */

declare module 'node:fs' {
  export function readFileSync(
    path: string,
    encoding: 'utf8',
  ): string
}

declare module 'node:path' {
  export function dirname(path: string): string
  export function resolve(
    ...paths: string[]
  ): string
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string
}
