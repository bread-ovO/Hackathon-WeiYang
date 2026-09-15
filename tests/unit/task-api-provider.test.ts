import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import {
  modelEndpoint,
  modelApiBody,
  parseModelApiResponse,
  callModelApi,
} from '../../apps/desktop/src/main/task-api-provider'
import {
  taskExtractionSchema,
  parseCoreRequest,
  parseHostRequest,
  type ModelConfig,
} from '@memo/contracts'
import {
  cliArguments,
  runAnalysisCli,
} from '../../apps/desktop/src/main/task-cli-provider'
import { createTaskModelProvider } from '../../apps/desktop/src/main/task-model-provider'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const config: ModelConfig = {
  provider: 'responses',
  enabled: true,
  baseUrl: 'https://example.com/v1/',
  model: 'test-model',
  credentialId: 'key-ref',
}
const input = {
  messages: [{ role: 'user' as const, content: 'synthetic' }],
  schema: taskExtractionSchema,
  signal: new AbortController().signal,
}
const response = {
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '{"tasks":[]}' }],
    },
  ],
}
describe('model provider boundary', () => {
  it('keeps provider configuration in main', () => {
    expect(
      parseCoreRequest({ method: 'modelProvider.configure', config }),
    ).toBeTruthy()
    expect(() =>
      parseHostRequest({ method: 'modelProvider.configure', config }),
    ).toThrow()
    expect(() =>
      parseCoreRequest({
        method: 'modelProvider.configure',
        config: { ...config, apiKey: 'secret' },
      }),
    ).toThrow()
  })
  it.each([
    'http://example.com/v1',
    'https://a:b@example.com/v1',
    'https://example.com/v1?token=x',
    'file:///tmp/model',
  ])('rejects unsafe endpoint %s', (baseUrl) =>
    expect(() => modelEndpoint({ ...config, baseUrl })).toThrow(),
  )
  it('builds both structured-output protocols', () => {
    expect(modelEndpoint(config).href).toBe('https://example.com/v1/responses')
    expect(modelApiBody(config, input)).toMatchObject({
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    })
    expect(
      modelApiBody({ ...config, provider: 'chat-completions' }, input),
    ).toMatchObject({
      messages: input.messages,
      response_format: { json_schema: { strict: true } },
    })
  })
  it('extracts output and rejects refusals, tools and incomplete responses', () => {
    expect(parseModelApiResponse('responses', response)).toBe('{"tasks":[]}')
    for (const bad of [
      { ...response, status: 'incomplete' },
      { ...response, output: [{ type: 'function_call' }] },
      {
        ...response,
        output: [
          {
            ...response.output[0],
            content: [{ type: 'refusal', refusal: 'no' }],
          },
        ],
      },
    ])
      expect(() => parseModelApiResponse('responses', bad)).toThrow()
    const chat = {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: '{}' },
        },
      ],
    }
    expect(parseModelApiResponse('chat-completions', chat)).toBe('{}')
    expect(() =>
      parseModelApiResponse('chat-completions', {
        choices: [{ ...chat.choices[0], finish_reason: 'length' }],
      }),
    ).toThrow()
  })
  it('sends scoped authorization and never follows redirects', async () => {
    let calls = 0
    const server = createServer((req, res) => {
      calls++
      expect(req.headers.authorization).toBe('Bearer fixture-key')
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/target' })
        res.end()
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
          store: false,
        })
        res.end(JSON.stringify(response))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    try {
      expect(
        await callModelApi(
          config,
          input,
          'fixture-key',
          new URL(`http://127.0.0.1:${address.port}/ok`),
        ),
      ).toBe('{"tasks":[]}')
      await expect(
        callModelApi(
          config,
          input,
          'fixture-key',
          new URL(`http://127.0.0.1:${address.port}/redirect`),
        ),
      ).rejects.toThrow('MODEL_UNAVAILABLE')
      expect(calls).toBe(2)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
  it('persists only public settings and defaults to disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bugu-provider-test-'))
    const path = join(dir, 'settings.json')
    try {
      const provider = createTaskModelProvider(path, async () => {
        throw new Error('must not read credential')
      })
      await expect(provider.analyze(input)).rejects.toThrow(
        'MODEL_NOT_CONFIGURED',
      )
      await provider.configure(config)
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config)
      expect(
        (await createTaskModelProvider(path, async () => '').status()).config,
      ).toEqual(config)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('CLI flags isolate sessions and disable execution tools', () => {
    const codex = cliArguments(
      { ...config, provider: 'codex-cli' },
      '/tmp/test',
      {},
    )
    expect(codex).toContain('--ephemeral')
    expect(codex).toContain('features.shell_tool=false')
    expect(codex).toContain('read-only')
    const claude = cliArguments(
      { ...config, provider: 'claude-cli' },
      '/tmp/test',
      {},
    )
    expect(claude[claude.indexOf('--tools') + 1]).toBe('')
    expect(claude).toContain('--no-session-persistence')
    expect(claude).not.toContain('--bare')
  })
  it('cancels a noninteractive child without waiting for stdin or login', async () => {
    const abort = new AbortController()
    const run = runAnalysisCli(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      tmpdir(),
      'fixture',
      abort.signal,
    )
    abort.abort()
    await expect(run).rejects.toThrow('MODEL_CANCELLED')
  })
})
