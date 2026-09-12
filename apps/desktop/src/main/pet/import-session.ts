import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

export interface DiscoveredEntries {
  /** Relative posix-style paths of *.model3.json files inside the root. */
  entries: string[]
  cmo3Found: boolean
}
export const discoveryLimits = { maxDepth: 4, maxDirectories: 512 } as const

/** Bounded scan for runtime model entries. `.cmo3` editor projects are counted
 * only so the UI can explain they are not importable in the first version. */
export async function findModelEntries(root: string): Promise<DiscoveredEntries> {
  const entries: string[] = []
  let cmo3Found = false
  let visited = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > discoveryLimits.maxDepth || visited > discoveryLimits.maxDirectories)
      return
    visited++
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      return
    }
    for (const name of names) {
      const full = path.join(directory, name)
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        await walk(full, depth + 1)
      } else if (
        name.toLowerCase().endsWith('.model3.json') &&
        name.length <= 256
      ) {
        entries.push(
          path.relative(root, full).split(path.sep).join(path.posix.sep),
        )
      } else if (name.toLowerCase().endsWith('.cmo3')) {
        cmo3Found = true
      }
    }
  }
  await walk(root, 0)
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return { entries, cmo3Found }
}

const safeEntry = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  !value.includes('\\') &&
  !path.posix.isAbsolute(value) &&
  value
    .split(path.posix.sep)
    .every((part) => part !== '' && part !== '.' && part !== '..')

/** Main-process memory of one directory selection. The renderer may only
 * echo back an entry this session actually discovered; the directory itself
 * never crosses the bridge. */
export class ImportSession {
  private directory: string | null = null
  private entries: readonly string[] = []
  /** Records a fresh selection and returns the reply payload for the UI. */
  choose(directory: string, discovered: DiscoveredEntries) {
    this.directory = directory
    this.entries = discovered.entries
    if (discovered.entries.length === 1)
      return { status: 'ready' as const, entry: discovered.entries[0]!, entries: [...discovered.entries] }
    if (discovered.entries.length > 1)
      return { status: 'choose' as const, entries: [...discovered.entries] }
    this.clear()
    return { status: 'no-model' as const, cmo3Found: discovered.cmo3Found }
  }
  /** Single-use: consumes the session so stale UI cannot import later. */
  consume(entry: string): string | null {
    if (!this.directory || !safeEntry(entry) || !this.entries.includes(entry))
      return null
    const directory = this.directory
    this.clear()
    return directory
  }
  pending(): boolean {
    return this.directory !== null
  }
  clear(): void {
    this.directory = null
    this.entries = []
  }
}
