import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.platform !== 'darwin')
  throw Error('macOS native validation required')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  temporary = mkdtempSync(join(tmpdir(), 'bugu-fullscreen-'))
try {
  const binary = join(temporary, 'probe-fixture')
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-framework',
      'AppKit',
      join(root, 'tests/native/pet-speech-environment.swift'),
      '-o',
      binary,
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
  execFileSync(
    binary,
    [join(root, 'apps/desktop/out/native/pet-speech-environment')],
    { stdio: 'inherit', timeout: 20000 },
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
