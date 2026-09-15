import { readFile, writeFile, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import {
  modelConfigSchema,
  type ModelConfig,
  type ModelProviderSnapshot,
} from '@memo/contracts'
import type { TaskModelRequest } from '@memo/model'
import { callModelApi, modelEndpoint } from './task-api-provider'
import { callModelCli, findModelCli } from './task-cli-provider'
const valid = new Ajv({ strict: true }).compile<ModelConfig>(modelConfigSchema)
const defaults: ModelConfig = {
  provider: 'responses',
  enabled: false,
  baseUrl: 'https://api.openai.com/v1',
  model: '',
  credentialId: '',
}
export function createTaskModelProvider(
  path: string,
  readCredential: (
    id: string,
    scope: { domain: string; purpose: 'model' },
  ) => Promise<string>,
) {
  let config = { ...defaults }
  let queue: Promise<unknown> = Promise.resolve()
  let lastRequest: ModelProviderSnapshot['lastRequest']
  const preview = (chosen: ModelConfig, input: TaskModelRequest) => {
    let remaining = 65536
    let truncated = false
    const messages = input.messages.map((message) => {
      const content = message.content.slice(0, remaining)
      truncated ||= content.length < message.content.length
      remaining -= content.length
      return { role: message.role, content }
    })
    lastRequest = {
      provider: chosen.provider,
      model: chosen.model || 'CLI 默认模型',
      destination: chosen.provider.endsWith('-cli')
        ? '本机 CLI 的已授权模型服务'
        : modelEndpoint(chosen).origin,
      purpose: input.purpose || 'task-analysis',
      sentAt: new Date().toISOString(),
      messages,
      truncated,
    }
  }
  const active = new Set<AbortController>()
  const loaded = readFile(path, 'utf8')
    .then((raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (valid(parsed)) config = parsed
    })
    .catch(() => {})
  const cancel = () => {
    for (const c of active) c.abort()
  }
  async function status(): Promise<ModelProviderSnapshot> {
    await loaded
    const availableClis = []
    for (const p of ['codex-cli', 'claude-cli'])
      if (await findModelCli(p)) availableClis.push(p)
    return {
      config: { ...config },
      availableClis,
      ...(lastRequest ? { lastRequest: structuredClone(lastRequest) } : {}),
    }
  }
  return {
    status,
    cancel,
    configure(next: ModelConfig) {
      const work = queue.then(async () => {
        await loaded
        if (!valid(next)) throw new Error('MODEL_CONFIG_INVALID')
        if (next.enabled) {
          if (
            next.provider === 'responses' ||
            next.provider === 'chat-completions'
          ) {
            modelEndpoint(next)
            if (!next.credentialId) throw new Error('MODEL_AUTH_REQUIRED')
          } else if (!(await findModelCli(next.provider)))
            throw new Error('MODEL_CLI_MISSING')
        }
        const temp = path + '.' + randomUUID() + '.tmp'
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 })
        await rename(temp, path)
        cancel()
        config = { ...next }
        return status()
      })
      queue = work.catch(() => {})
      return work
    },
    async analyze(
      input: TaskModelRequest,
    ): Promise<{ content: string; model: string }> {
      await loaded
      await queue
      const chosen = { ...config }
      if (!chosen.enabled) throw new Error('MODEL_NOT_CONFIGURED')
      const controller = new AbortController()
      const abort = () => controller.abort()
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) controller.abort()
      active.add(controller)
      try {
        let content: string
        const request = { ...input, signal: controller.signal }
        if (
          chosen.provider === 'responses' ||
          chosen.provider === 'chat-completions'
        ) {
          const endpoint = modelEndpoint(chosen)
          const secret = await readCredential(chosen.credentialId, {
            domain: endpoint.hostname,
            purpose: 'model',
          })
          if (controller.signal.aborted) throw new Error('MODEL_CANCELLED')
          preview(chosen, request)
          content = await callModelApi(chosen, request, secret, endpoint)
        } else {
          if (controller.signal.aborted) throw new Error('MODEL_CANCELLED')
          preview(chosen, request)
          content = await callModelCli(chosen, request)
        }
        if (controller.signal.aborted) throw new Error('MODEL_CANCELLED')
        const identity = createHash('sha256')
          .update(JSON.stringify(chosen))
          .digest('hex')
          .slice(0, 12)
        return {
          content,
          model: `${chosen.provider}/${chosen.model || 'CLI 默认模型'} (${identity})`,
        }
      } finally {
        active.delete(controller)
        input.signal.removeEventListener('abort', abort)
      }
    },
  }
}
