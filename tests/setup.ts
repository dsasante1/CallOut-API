import { vi } from 'vitest'

const chromeMock = {
  runtime: {
    getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
    onMessage: {
      addListener: vi.fn(),
    },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
  },
}

Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true })
