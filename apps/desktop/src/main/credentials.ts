import { dialog, safeStorage, type BrowserWindow } from 'electron'
import type {
  CoreReply,
  CoreRequest,
  CredentialsSnapshot,
} from '@memo/contracts'
import { createCredentialVault, CredentialVaultError } from './credential-vault'
import { readCredentialFile } from './credential-input'

export function encryptionAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' ||
      !['basic_text', 'unknown'].includes(
        safeStorage.getSelectedStorageBackend(),
      ))
  )
}
export function createSystemCredentialVault(root: string) {
  return createCredentialVault(root, {
    isAvailable: encryptionAvailable,
    encrypt: (text: string) => safeStorage.encryptString(text),
    decrypt: (bytes: Uint8Array) =>
      safeStorage.decryptString(Buffer.from(bytes)),
  })
}
/** Only this host service can import/decrypt credentials; renderer receives references. */
export function createCredentialsHandler(
  root: string,
  getWindow: () => BrowserWindow | null,
  sharedVault?: ReturnType<typeof createSystemCredentialVault>,
) {
  const vault = sharedVault ?? createSystemCredentialVault(root)
  let choosing = false
  const snapshot = async (): Promise<CredentialsSnapshot> => ({
    credentials: await vault.list(),
    encryptionAvailable: encryptionAvailable(),
  })
  return async (
    request: Extract<CoreRequest, { method: `credentials.${string}` }>,
  ): Promise<CoreReply<CredentialsSnapshot>> => {
    try {
      if (request.method === 'credentials.importFile') {
        if (choosing) return { ok: false, error: 'VAULT_UNAVAILABLE' }
        if (!encryptionAvailable())
          return { ok: false, error: 'VAULT_UNAVAILABLE' }
        const owner = getWindow()
        if (!owner) return { ok: false, error: 'VAULT_UNAVAILABLE' }
        choosing = true
        try {
          const selection = await dialog.showOpenDialog(owner, {
            title: '选择单行凭据文件',
            properties: ['openFile'],
            filters: [
              { name: '凭据文件', extensions: ['txt', 'token', 'key'] },
            ],
          })
          if (selection.canceled || !selection.filePaths[0])
            return {
              ok: true,
              data: { ...(await snapshot()), cancelled: true },
            }
          const secret = await readCredentialFile(selection.filePaths[0])
          await vault.import(
            {
              label: request.label,
              domain: request.domain,
              purpose: request.purpose,
            },
            secret,
          )
        } finally {
          choosing = false
        }
      } else if (request.method === 'credentials.remove')
        await vault.remove(request.id)
      return { ok: true, data: await snapshot() }
    } catch (error) {
      if (error instanceof CredentialVaultError)
        return {
          ok: false,
          error:
            error.code === 'CREDENTIAL_INVALID_INPUT'
              ? 'INVALID_REQUEST'
              : error.code,
        }
      return { ok: false, error: 'VAULT_INVALID_DATA' }
    }
  }
}
