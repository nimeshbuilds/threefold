import type { TwofoldApi } from '@shared/types'

declare global {
  interface Window {
    twofold: TwofoldApi & { onMenu(listener: (command: string) => void): () => void }
  }
}

export {}
