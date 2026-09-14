import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ModelConfig } from '@memo/contracts'
import type { TaskModelRequest } from '@memo/model'
export async function findModelCli(provider: string): Promise<string | null> {
  const name =
    provider === 'codex-cli'
      ? 'codex'
      : provider === 'claude-cli'
        ? 'claude'
        : null
  if (!name) return null
  const dirs = [
    join(homedir(), '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(process.env.PATH ?? '').split(delimiter),
  ]
  const candidates = [...dirs.filter(isAbsolute).map((dir) => join(dir, name))]
  if (name === 'codex' && process.platform === 'darwin')
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
    )
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK)
      return path
    } catch {
      /* next */
    }
  }
  return null
}
export function cliArguments(
  config: ModelConfig,
  dir: string,
  schema: unknown,
): string[] {
  const model = config.model.trim() ? ['--model', config.model.trim()] : []
  if (config.provider === 'codex-cli')
    return [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      'features.shell_tool=false',
      '-c',
      'features.hooks=false',
      '-c',
      'features.apps=false',
      '-c',
      'web_search="disabled"',
      '-c',
      'project_doc_max_bytes=0',
      '--output-schema',
      join(dir, 'schema.json'),
      '--output-last-message',
      join(dir, 'result.json'),
      '--color',
      'never',
      ...model,
      '-',
    ]
  if (config.provider === 'claude-cli')
    return [
      '--print',
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--settings',
      '{"disableAllHooks":true}',
      ...model,
    ]
  throw new Error('MODEL_CLI_UNSUPPORTED')
}
export function runAnalysisCli(
  executable: string,
  args: string[],
  cwd: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('MODEL_CANCELLED'))
    // CLI owns its login; never read/copy auth files. Remove nested agent session markers.
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let bytes = 0
    let failure = ''
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* exited */
      }
    }
    const abort = () => {
      failure = 'MODEL_CANCELLED'
      kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      failure = 'MODEL_TIMEOUT'
      kill()
    }, 60_000)
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 512 * 1024) {
        failure = 'INVALID_TASK_ANALYSIS'
        kill()
      } else output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 512 * 1024) {
        failure = 'INVALID_TASK_ANALYSIS'
        kill()
      }
    })
    child.stdin.on('error', () => {
      /* close reports failure */
    })
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    child.on('error', () => {
      cleanup()
      reject(new Error('MODEL_UNAVAILABLE'))
    })
    child.on('close', (code) => {
      cleanup()
      if (failure || code !== 0)
        reject(new Error(failure || 'MODEL_CLI_FAILED'))
      else resolve(output)
    })
    child.stdin.end(prompt)
  })
}
export async function callModelCli(
  config: ModelConfig,
  input: TaskModelRequest,
): Promise<string> {
  const executable = await findModelCli(config.provider)
  if (!executable) throw new Error('MODEL_CLI_MISSING')
  const dir = await mkdtemp(join(tmpdir(), 'bugu-analysis-'))
  try {
    await writeFile(join(dir, 'schema.json'), JSON.stringify(input.schema), {
      mode: 0o600,
    })
    const prompt =
      input.messages
        .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
        .join('\n\n') + '\n只返回符合 JSON Schema 的分析结果。不要使用工具。'
    const output = await runAnalysisCli(
      executable,
      cliArguments(config, dir, input.schema),
      dir,
      prompt,
      input.signal,
    )
    if (input.signal.aborted) throw new Error('MODEL_CANCELLED')
    if (config.provider === 'codex-cli') {
      const result = await readFile(join(dir, 'result.json'), 'utf8')
      if (Buffer.byteLength(result) > 65536)
        throw new Error('INVALID_TASK_ANALYSIS')
      return result
    }
    let result
    try {
      result = JSON.parse(output)
    } catch {
      throw new Error('INVALID_TASK_ANALYSIS')
    }
    if (
      result.is_error ||
      result.subtype !== 'success' ||
      !result.structured_output
    )
      throw new Error('MODEL_CLI_FAILED')
    return JSON.stringify(result.structured_output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
