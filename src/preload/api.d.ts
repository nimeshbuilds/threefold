import type { ThreefoldApi } from '@shared/types'

declare global {
  interface Window {
    threefold: ThreefoldApi & { onMenu(listener: (command: string) => void): () => void }
  }
}

export {}
