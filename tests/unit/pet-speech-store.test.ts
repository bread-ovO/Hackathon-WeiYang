import { it, expect } from 'vitest'
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPetSpeechState } from '@memo/domain'
import { createPetSpeechStore } from '../../apps/desktop/src/main/pet/speech-store'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
it('persists validated quota and preferences, rejects corrupt, oversized and symlink states', async (ctx) => {
  const root = await mkdtemp(join(tmpdir(), 'bugu-speech-store-'))
  try {
    const file = join(root, 'speech.json'),
      store = createPetSpeechStore(file)
    expect(await store.load()).toBeNull()
    const state = createPetSpeechState(
      { now: () => Date.parse('2026-09-13T10:00:00Z'), random: () => 0 },
      { enabled: true },
    )
    state.count = 4
    state.recent = ['water', 'eyes']
    await store.save(state)
    expect(await createPetSpeechStore(file).load()).toEqual(state)
    // POSIX enforces the 0o600 write; Windows collapses create modes to 0o666
    // unless the readonly bit is set, so accept both instead of failing.
    expect((await stat(file)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600)
    const valid = await readFile(file, 'utf8')
    await writeFile(file, 'x'.repeat(16385))
    await expect(store.load()).rejects.toThrow()
    await writeFile(file, '{}')
    await expect(store.load()).rejects.toThrow()
    await writeFile(join(root, 'target'), valid)
    await rm(file)
    await symlinkOrSkip(ctx, join(root, 'target'), file)
    await expect(store.load()).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
