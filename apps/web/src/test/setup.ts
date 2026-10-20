import { expect } from 'vitest'

import * as jestDom from '@testing-library/jest-dom/matchers'

// @testing-library/jest-dom v6 exports a matcher map; extend the
// Vitest expect explicitly (its auto-detection targets jest/globals).
for (const [name, matcher] of Object.entries(jestDom)) {
  expect.extend({ [name]: matcher as never })
}

// happy-dom does not implement the browser `EventSource` global.
// The Work Item realtime surface (`src/api/work-item-events.ts`)
// requires the global to exist; in the unit-test environment an
// INERT stand-in is provided instead: it records instances (so a
// test can assert a stream was requested) but never connects and
// never emits. Tests that exercise stream behavior replace it with
// a controllable mock via `vi.stubGlobal('EventSource', ...)`.
class InertEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2

  static instances: InertEventSource[] = []

  readonly url: string
  readonly withCredentials: boolean
  readyState: number = InertEventSource.CONNECTING

  constructor(
    url: string,
    init?: { withCredentials?: boolean },
  ) {
    this.url = url
    this.withCredentials = init?.withCredentials ?? false
    InertEventSource.instances.push(this)
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  close(): void {
    this.readyState = InertEventSource.CLOSED
  }
}

if (typeof globalThis.EventSource === 'undefined') {
  Object.defineProperty(globalThis, 'EventSource', {
    value: InertEventSource,
    writable: true,
    configurable: true,
  })
}
