import { request } from 'node:http'
import type { TaskModelTransport } from '@memo/model'

/** Fixed loopback only. No proxy environment, redirects, credentials or tools. */
export const localTaskModelTransport: TaskModelTransport = (input) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'qwen2.5:7b',
      messages: [
        {
          role: 'system',
          content: input.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n'),
        },
        {
          role: 'user',
          content:
            input.messages
              .filter((m) => m.role === 'user')
              .map((m) => m.content)
              .join('\n') + '\n请按上面的要求分析这些会话，输出 tasks JSON。',
        },
      ],
      format: JSON.parse(
        JSON.stringify(input.schema, (key, value) =>
          ['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)
            ? undefined
            : value,
        ),
      ),
      stream: false,
      options: { temperature: 0, num_ctx: 16384, num_predict: 4096 },
    })
    if (Buffer.byteLength(body) > 512 * 1024)
      return reject(new Error('MODEL_INPUT_TOO_LARGE'))
    const req = request(
      {
        hostname: '127.0.0.1',
        port: 11434,
        path: '/api/chat',
        method: 'POST',
        agent: false,
        signal: input.signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error('MODEL_UNAVAILABLE'))
          return
        }
        const chunks: Buffer[] = []
        let bytes = 0
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 256 * 1024) {
            req.destroy()
            reject(new Error('INVALID_TASK_ANALYSIS'))
            return
          }
          chunks.push(chunk)
        })
        res.on('error', () => reject(new Error('MODEL_UNAVAILABLE')))
        res.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (
              value.done !== true ||
              value.done_reason === 'length' ||
              value.message?.role !== 'assistant' ||
              typeof value.message.content !== 'string' ||
              (value.message.tool_calls?.length ?? 0) !== 0
            )
              throw new Error()
            resolve(value.message.content)
          } catch {
            reject(new Error('INVALID_TASK_ANALYSIS'))
          }
        })
      },
    )
    req.setTimeout(60_000, () => req.destroy(new Error('MODEL_TIMEOUT')))
    req.on('error', () =>
      reject(
        new Error(
          input.signal.aborted ? 'MODEL_CANCELLED' : 'MODEL_UNAVAILABLE',
        ),
      ),
    )
    req.end(body)
  })
