// API keys are encrypted with Electron's safeStorage before they touch disk.
// On macOS the encryption key is held in the login Keychain, so the file on
// disk is useless on another machine or to another user account.

import fs from 'node:fs'
import { safeStorage } from 'electron'
import type { KeyStatus, Provider } from '@shared/types'

type Vault = Partial<Record<Provider, string>>

export class Secrets {
  private cache: Partial<Record<Provider, string>> = {}

  constructor(private readonly file: string) {}

  private readVault(): Vault {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Vault
    } catch {
      return {}
    }
  }

  private writeVault(vault: Vault): void {
    fs.writeFileSync(this.file, JSON.stringify(vault), { mode: 0o600 })
  }

  get(provider: Provider): string | null {
    const cached = this.cache[provider]
    if (cached) return cached
    const encrypted = this.readVault()[provider]
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return null
    try {
      const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
      this.cache[provider] = key
      return key
    } catch {
      return null
    }
  }

  set(provider: Provider, key: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this computer, so the key was not saved.')
    }
    const vault = this.readVault()
    vault[provider] = safeStorage.encryptString(key).toString('base64')
    this.writeVault(vault)
    this.cache[provider] = key
  }

  remove(provider: Provider): void {
    const vault = this.readVault()
    delete vault[provider]
    this.writeVault(vault)
    delete this.cache[provider]
  }

  status(): KeyStatus {
    return { claude: this.get('claude') !== null, chatgpt: this.get('chatgpt') !== null }
  }
}
