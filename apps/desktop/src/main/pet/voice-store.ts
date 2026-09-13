import { lstat, open, mkdir, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  parsePetVoicePreferences,
  type PetVoicePreferences,
} from '@memo/contracts'
export function createPetVoiceStore(file: string) {
  return {
    async load(): Promise<PetVoicePreferences | null> {
      try {
        const before = await lstat(file)
        if (!before.isFile() || before.isSymbolicLink() || before.size > 8192)
          throw Error()
        const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const stat = await fd.stat()
          if (
            stat.ino !== before.ino ||
            stat.dev !== before.dev ||
            stat.size !== before.size
          )
            throw Error()
          const bytes = Buffer.alloc(8193)
          let count = 0
          while (count < bytes.length) {
            const r = await fd.read(bytes, count, bytes.length - count, count)
            if (!r.bytesRead) break
            count += r.bytesRead
          }
          const after = await fd.stat()
          if (
            count !== stat.size ||
            after.size !== stat.size ||
            after.mtimeMs !== stat.mtimeMs ||
            count > 8192
          )
            throw Error()
          return parsePetVoicePreferences(
            JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(
                bytes.subarray(0, count),
              ),
            ),
          )
        } finally {
          await fd.close()
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw Error('PET_VOICE_STORAGE')
      }
    },
    async save(value: PetVoicePreferences) {
      const text = JSON.stringify(parsePetVoicePreferences(value))
      const staging = `${file}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(file), { recursive: true })
        const fd = await open(staging, 'wx', 0o600)
        try {
          await fd.writeFile(text)
          await fd.sync()
        } finally {
          await fd.close()
        }
        await rename(staging, file)
        // Node cannot portably open/fsync directory handles on Windows.
        // Keep file sync + atomic rename there; do not claim POSIX directory durability.
        if (process.platform !== 'win32') {
          const dir = await open(dirname(file), 'r')
          try {
            await dir.sync()
          } finally {
            await dir.close()
          }
        }
      } catch {
        throw Error('PET_VOICE_STORAGE')
      } finally {
        await rm(staging, { force: true }).catch(() => undefined)
      }
    },
  }
}
