import { it, expect } from 'vitest'
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  symlink,
  stat,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPetSpeechState } from '@memo/domain'
import { createPetSpeechStore } from '../../apps/desktop/src/main/pet/speech-store'
it('persists validated quota and preferences, rejects corrupt, oversized and symlink states', async () => {
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
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const valid = await readFile(file, 'utf8')
    await writeFile(file, 'x'.repeat(16385))
    await expect(store.load()).rejects.toThrow()
    await writeFile(file, '{}')
    await expect(store.load()).rejects.toThrow()
    await writeFile(join(root, 'target'), valid)
    await rm(file)
    await symlink(join(root, 'target'), file)
    await expect(store.load()).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
