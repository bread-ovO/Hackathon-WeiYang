import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LOCAL_JSONL_MANIFEST_EXAMPLE } from '@memo/plugin-host'

/** Only synthetic, shipped text. No user paths or remote credentials are accepted. */
export async function prepareBuiltinDemo(dataRoot: string) {
  const parent = join(dataRoot, 'builtin-sources')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(await realpath(parent), 'demo-'))
  const manifest = {
    ...LOCAL_JSONL_MANIFEST_EXAMPLE,
    id: 'bugu-builtin-demo',
    displayName: '不咕体验插件（虚构数据）',
    permissions: {
      domains: [],
      credentials: [],
      directories: [
        {
          id: 'exports',
          purpose: '只读取应用生成的三条虚构工作记录，不访问个人文件',
        },
      ],
    },
  }
  const records = [
    '我会补充登录修复的验证记录。',
    '我会整理开放平台的接入说明。',
    '如果需要，我会提交额外的测试报告。',
  ].map((content, i) =>
    JSON.stringify({
      id: `builtin-demo-${i}`,
      revision: '1',
      created_at: '2026-09-13T00:00:00Z',
      content,
    }),
  )
  const file = join(directory, 'plugin.json')
  await writeFile(file, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'events.jsonl'), records.join('\n') + '\n', {
    flag: 'wx',
    mode: 0o600,
  })
  return { file, directory }
}
