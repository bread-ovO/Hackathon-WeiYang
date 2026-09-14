import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { ModelConfig } from '@memo/contracts'
import type { TaskModelRequest } from '@memo/model'

export function modelEndpoint(config: ModelConfig): URL {
  let url: URL
  try {
    url = new URL(config.baseUrl)
  } catch {
    throw new Error('MODEL_CONFIG_INVALID')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !config.model.trim()
  )
    throw new Error('MODEL_CONFIG_INVALID')
  url.pathname =
    url.pathname.replace(/\/+$/, '') +
    (config.provider === 'responses' ? '/responses' : '/chat/completions')
  return url
}
export function modelApiBody(config: ModelConfig, input: TaskModelRequest) {
  const format = { name: 'task_analysis', strict: true, schema: input.schema }
  return config.provider === 'responses'
    ? {
        model: config.model,
        input: input.messages,
        text: { format: { type: 'json_schema', ...format } },
        store: false,
        stream: false,
        max_output_tokens: 8192,
      }
    : {
        model: config.model,
        messages: input.messages,
        response_format: { type: 'json_schema', json_schema: format },
        stream: false,
        max_completion_tokens: 8192,
      }
}
export function parseModelApiResponse(
  provider: ModelConfig['provider'],
  value: unknown,
): string {
  const v = value as Record<string, any>
  if (!v || typeof v !== 'object' || v.error)
    throw new Error('INVALID_TASK_ANALYSIS')
  if (provider === 'responses') {
    if (v.status !== 'completed' || !Array.isArray(v.output))
      throw new Error('INVALID_TASK_ANALYSIS')
    const texts: string[] = []
    for (const item of v.output) {
      if (item.type === 'reasoning') continue
      if (
        item.type !== 'message' ||
        item.role !== 'assistant' ||
        item.status !== 'completed' ||
        !Array.isArray(item.content)
      )
        throw new Error('INVALID_TASK_ANALYSIS')
      for (const part of item.content) {
        if (part.type !== 'output_text' || typeof part.text !== 'string')
          throw new Error('INVALID_TASK_ANALYSIS')
        texts.push(part.text)
      }
    }
    if (!texts.length) throw new Error('INVALID_TASK_ANALYSIS')
    return texts.join('')
  }
  const choice = v.choices?.[0]
  if (
    v.choices?.length !== 1 ||
    choice?.finish_reason !== 'stop' ||
    choice.message?.role !== 'assistant' ||
    choice.message?.refusal ||
    choice.message?.tool_calls?.length ||
    choice.message?.function_call ||
    typeof choice.message?.content !== 'string'
  )
    throw new Error('INVALID_TASK_ANALYSIS')
  return choice.message.content
}
/** Redirects are never followed. Error bodies and authorization values never leave main. */
export function callModelApi(
  config: ModelConfig,
  input: TaskModelRequest,
  key: string,
  endpoint = modelEndpoint(config),
): Promise<string> {
  const body = JSON.stringify(modelApiBody(config, input))
  return new Promise((resolve, reject) => {
    if (Buffer.byteLength(body) > 512 * 1024)
      return reject(new Error('MODEL_INPUT_TOO_LARGE'))
    const req = (endpoint.protocol === 'https:' ? httpsRequest : httpRequest)(
      endpoint,
      {
        method: 'POST',
        signal: input.signal,
        agent: false,
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(
            new Error(
              res.statusCode === 401 || res.statusCode === 403
                ? 'MODEL_AUTH_REQUIRED'
                : res.statusCode === 429
                  ? 'MODEL_RATE_LIMITED'
                  : 'MODEL_UNAVAILABLE',
            ),
          )
          return
        }
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          length += chunk.length
          if (length > 256 * 1024) {
            reject(new Error('INVALID_TASK_ANALYSIS'))
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        res.on('error', () => reject(new Error('MODEL_UNAVAILABLE')))
        res.on('end', () => {
          try {
            resolve(
              parseModelApiResponse(
                config.provider,
                JSON.parse(Buffer.concat(chunks).toString('utf8')),
              ),
            )
          } catch {
            reject(new Error('INVALID_TASK_ANALYSIS'))
          }
        })
      },
    )
    req.setTimeout(60_000, () => {
      reject(new Error('MODEL_TIMEOUT'))
      req.destroy()
    })
    req.on('error', () =>
      reject(
        new Error(
          input.signal.aborted ? 'MODEL_CANCELLED' : 'MODEL_UNAVAILABLE',
        ),
      ),
    )
    req.end(body)
  })
}
