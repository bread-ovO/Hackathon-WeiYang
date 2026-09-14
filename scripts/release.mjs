import { appendFileSync, createReadStream, mkdtempSync, readdirSync, lstatSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function releaseVersion(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag ?? '')
  if (!match || match[0] !== tag || match[4]?.split('.').some((id) => /^0\d+$/.test(id))) {
    throw new Error('Use a version tag such as v0.1.0 or v0.2.0-rc.1')
  }
  return { version: tag.slice(1), prerelease: Boolean(match[4]) }
}

export function installerNames(version) {
  return [
    `BUGU-${version}-Windows-x64-Setup.exe`,
    `BUGU-${version}-macOS-arm64.dmg`,
    `BUGU-${version}-macOS-x64.dmg`,
    `BUGU-${version}-Linux-x64.AppImage`,
    `BUGU-${version}-Linux-x64.deb`,
  ].sort()
}

export async function verifyInstallers(tag, directory) {
  const { version } = releaseVersion(tag)
  const expected = installerNames(version)
  const actual = readdirSync(directory).filter((name) => name !== 'SHA256SUMS').sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Incomplete or unexpected release assets. Expected: ${expected.join(', ')}; found: ${actual.join(', ')}`)
  }
  const sums = []
  for (const name of expected) {
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`Invalid installer: ${name}`)
    }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    sums.push(`${hash.digest('hex')}  ${name}`)
  }
  writeFileSync(join(directory, 'SHA256SUMS'), sums.join('\n') + '\n')
  return [...expected, 'SHA256SUMS'].map((name) => join(directory, name))
}

function gh(args, optional = false) {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !optional) throw new Error(result.stderr || 'GitHub release command failed')
  return result
}

async function publish(tag, directory) {
  const { prerelease } = releaseVersion(tag)
  const files = await verifyInstallers(tag, directory)
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('GITHUB_REPOSITORY is required')
  const repo = ['--repo', repository]
  const existing = gh(['release', 'view', tag, ...repo, '--json', 'isDraft'], true)
  if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft) {
    throw new Error('This release is already published. Use a new version tag; published installers are never overwritten.')
  }
  if (existing.status !== 0) {
    const temporary = mkdtempSync(join(tmpdir(), 'bugu-release-notes-'))
    try {
      const notes = join(temporary, 'notes.md')
      writeFileSync(notes, [
        'BUGU 不咕 · 空白个人工作区，内置来源连接入口和桃濑日和。',
        '',
        '| 平台 | 安装包 |',
        '| --- | --- |',
        '| Windows x64 | Setup.exe |',
        '| macOS Apple Silicon / Intel | 对应 arm64 / x64 的 DMG |',
        '| Linux x64 | AppImage 或 deb |',
        '',
        '首次启动没有演示项目或样例事项。SHA256SUMS 可用于核对下载文件。',
        '',
        '本版本尚未配置 Windows 代码签名和 macOS Developer ID 签名、公证，系统可能提示无法验证发布者。',
      ].join('\n'))
      gh(['release', 'create', tag, ...repo, '--verify-tag', '--draft', '--title', `BUGU ${tag}`, '--notes-file', notes, '--generate-notes', ...(prerelease ? ['--prerelease'] : [])])
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
  // A failed upload leaves a draft. Reruns may replace draft files, never a public release.
  gh(['release', 'upload', tag, ...repo, ...files, '--clobber'])
  gh(['release', 'edit', tag, ...repo, '--draft=false', `--prerelease=${prerelease}`])
  console.log(gh(['release', 'view', tag, ...repo, '--json', 'url', '--jq', '.url']).stdout.trim())
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory = 'release-assets'] = process.argv.slice(2)
  const tag = process.env.RELEASE_TAG
  if (command === 'version') {
    const metadata = releaseVersion(tag)
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${metadata.version}\n`)
    }
    console.log(metadata.version)
  } else if (command === 'verify') {
    console.log((await verifyInstallers(tag, resolve(directory))).join('\n'))
  } else if (command === 'publish') {
    await publish(tag, resolve(directory))
  } else {
    throw new Error('Use: release.mjs version | verify [directory] | publish [directory]')
  }
}
