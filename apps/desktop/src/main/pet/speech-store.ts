import { lstat, open, mkdir, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parsePetSpeechState, type PetSpeechState } from '@memo/domain'

/** Local policy state only: no model paths, task text, or credentials. */
export function createPetSpeechStore(file: string) {
  return {
    async load(): Promise<PetSpeechState | null> {
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
          throw new Error('INVALID_SPEECH_STATE')
        const handle = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          const opened = await handle.stat()
          if (
            opened.ino !== stat.ino ||
            opened.dev !== stat.dev ||
            !opened.isFile() ||
            opened.size > 16384
          )
            throw new Error('INVALID_SPEECH_STATE')
          const bytes = Buffer.alloc(16385)
          let total = 0
          while (total < bytes.length) {
            const result = await handle.read(
              bytes,
              total,
              bytes.length - total,
              total,
            )
            if (!result.bytesRead) break
            total += result.bytesRead
          }
          if (total > 16384) throw new Error('INVALID_SPEECH_STATE')
          return parsePetSpeechState(
            JSON.parse(bytes.subarray(0, total).toString('utf8')),
          )
        } finally {
          await handle.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async save(value: PetSpeechState): Promise<void> {
      const text = JSON.stringify(parsePetSpeechState(value))
      await mkdir(dirname(file), { recursive: true })
      const staging = `${file}.${randomUUID()}.tmp`
      try {
        const handle = await open(staging, 'wx', 0o600)
        try {
          await handle.writeFile(text)
          await handle.sync()
        } finally {
          await handle.close()
        }
        await rename(staging, file)
        // Directory fsync anchors the rename on POSIX; Windows rejects
        // directory fsync with EPERM, where NTFS metadata journaling makes
        // it unnecessary anyway. Treat EPERM as success rather than failing
        // every save on Windows.
        const directory = await open(dirname(file), 'r')
        try {
          await directory.sync()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
        } finally {
          await directory.close()
        }
      } finally {
        await rm(staging, { force: true })
      }
    },
  }
}
