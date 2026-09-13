import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform === 'darwin') {
  const output = resolve(root, 'apps/desktop/out/native/pet-speech-environment')
  mkdirSync(dirname(output), { recursive: true })
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-framework',
      'AppKit',
      '-framework',
      'CoreGraphics',
      resolve(root, 'apps/desktop/native/pet-speech-environment.swift'),
      '-o',
      output,
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-framework',
      'AVFoundation',
      resolve(root, 'apps/desktop/native/pet-tts.swift'),
      '-o',
      resolve(root, 'apps/desktop/out/native/pet-tts'),
    ],
    { stdio: 'inherit', timeout: 120000 },
  )
}
