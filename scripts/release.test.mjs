import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { releaseVersion, installerNames, verifyInstallers } from './release.mjs'

test('release tags distinguish stable and prerelease versions and reject unsafe or malformed tags', () => {
  assert.deepEqual(releaseVersion('v0.1.0'), { version: '0.1.0', prerelease: false })
  assert.deepEqual(releaseVersion('v1.2.3-rc.1'), { version: '1.2.3-rc.1', prerelease: true })
  for (const tag of ['main', '0.1.0', 'v01.2.3', 'v1.2.3-01', 'v1.2.3/x', 'v1.2.3\n', 'v1.2.3\nversion=evil', 'v$(id)', undefined]) {
    assert.throws(() => releaseVersion(tag))
  }
})

test('publishing requires the complete installer set and produces verifiable checksums', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bugu-release-test-'))
  const names = installerNames('0.1.0')
  try {
    for (const name of names.slice(1)) writeFileSync(join(root, name), 'installer fixture')
    await assert.rejects(verifyInstallers('v0.1.0', root), /Incomplete/)
    writeFileSync(join(root, names[0]), '')
    await assert.rejects(verifyInstallers('v0.1.0', root), /Invalid installer/)
    writeFileSync(join(root, names[0]), 'installer fixture')
    const files = await verifyInstallers('v0.1.0', root)
    assert.equal(files.length, 6)
    const checksum = createHash('sha256').update('installer fixture').digest('hex')
    assert.equal(readFileSync(join(root, 'SHA256SUMS'), 'utf8'), names.map((name) => `${checksum}  ${name}\n`).join(''))
    await verifyInstallers('v0.1.0', root)
    writeFileSync(join(root, 'memo.sqlite'), 'not an installer')
    await assert.rejects(verifyInstallers('v0.1.0', root), /unexpected/)
    rmSync(join(root, 'memo.sqlite'))
    rmSync(join(root, names[0]))
    mkdirSync(join(root, names[0]))
    await assert.rejects(verifyInstallers('v0.1.0', root), /Invalid installer/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
