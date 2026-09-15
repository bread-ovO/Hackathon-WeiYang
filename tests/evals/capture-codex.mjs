/** Capture ONLY a new synthetic session. Does not list/read personal rollouts. */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
if (process.env.BUGU_EVAL_LIVE !== '1') throw Error('LIVE_OPT_IN_REQUIRED')
if (!process.argv[2]) throw Error('OUTPUT_DIRECTORY_REQUIRED')
const output = resolve(process.argv[2])
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'bugu-codex-synthetic-'))
const binary = execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
const prompt =
  '我明天会整理 BUGU 测试验收报告，目前尚未完成。你只需帮我确认当前隔离目录（仅执行 pwd），作为报告的环境信息，不要读文件、访问网络或执行其他命令，之后回复等待我完成报告。'
const localTimestamp = (at) => {
  const d = new Date(at),
    offset = -d.getTimezoneOffset()
  return (
    new Date(d.getTime() + offset * 60000).toISOString().slice(0, -1) +
    (offset < 0 ? '-' : '+') +
    String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0') +
    ':' +
    String(Math.abs(offset) % 60).padStart(2, '0')
  )
}
const records = [{ kind: 'input', at: new Date().toISOString(), text: prompt }]
const child = spawn(
  binary,
  [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    'allow_login_shell=false',
    '-c',
    'approval_policy="never"',
    '-c',
    'features.hooks=false',
    '-c',
    'features.apps=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'project_doc_max_bytes=0',
    '--json',
    '--color',
    'never',
    '-',
  ],
  { cwd: directory, stdio: ['pipe', 'pipe', 'ignore'], detached: true },
)
let buffer = '',
  parseError = false
child.stdin.end(prompt)
child.stdin.on('error', () => {})
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    try {
      records.push({
        kind: 'event',
        at: new Date().toISOString(),
        event: JSON.parse(line),
      })
    } catch {
      parseError = true
    }
  }
})
const stop = () => {
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
const timer = setTimeout(stop, 90000)
try {
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (exitCode !== 0 || parseError || buffer.trim())
    throw Error('CAPTURE_FAILED')
  const commands = records
    .filter(
      (r) =>
        r.event?.type === 'item.completed' &&
        r.event.item?.type === 'command_execution',
    )
    .map((r) => r.event.item)
  if (
    !commands.length ||
    commands.some(
      (item) =>
        !/^(?:\/bin\/)?(?:ba|z)?sh -c pwd$/.test(item.command) ||
        item.exit_code !== 0,
    )
  )
    throw Error('CAPTURE_COMMAND_REVIEW_REQUIRED')
  await writeFile(
    join(output, 'capture.json'),
    JSON.stringify(
      {
        version,
        captureTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        synthetic: true,
        ephemeral: true,
        exitCode,
        records,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  await writeFile(
    join(output, 'session.jsonl'),
    records
      .map(({ at, ...payload }) =>
        JSON.stringify({
          type: 'codex_exec_capture',
          formatVersion: 1,
          timestamp: localTimestamp(at),
          payload,
        }),
      )
      .join('\n') + '\n',
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ output, version, records: records.length }))
} finally {
  clearTimeout(timer)
  stop()
  await rm(directory, { recursive: true, force: true })
}
