import {
  request,
  type RequestOptions,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http'
import {
  PetModelError,
  type LocalModelTransport,
  type PetModelErrorCode,
} from '@memo/model'

export type LocalModelRequest = (
  options: RequestOptions,
  listener: (response: IncomingMessage) => void,
) => ClientRequest
/** Dedicated fixed loopback capability. Does not use proxy environment variables,
 * resolve names, follow redirects, accept credentials, or expose endpoint input. */
export function createLocalModelTransport(
  send: LocalModelRequest = request,
): LocalModelTransport {
  let busy = false
  return async (body, signal) => {
    if (!signal || typeof signal.addEventListener !== 'function')
      throw new PetModelError('PET_MODEL_UNAVAILABLE')
    if (signal.aborted) throw new PetModelError('PET_MODEL_CANCELLED')
    if (
      typeof body !== 'string' ||
      Buffer.byteLength(body, 'utf8') > 16 * 1024 ||
      !body.length
    )
      throw new PetModelError('PET_MODEL_UNAVAILABLE')
    if (busy) throw new PetModelError('PET_MODEL_BUSY')
    busy = true
    try {
      return await new Promise<string>((resolve, reject) => {
        let req: ClientRequest | undefined,
          response: IncomingMessage | undefined,
          settled = false
        const chunks: Buffer[] = []
        let bytes = 0
        const cleanup = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
        const fail = (code: PetModelErrorCode) => {
          if (settled) return
          settled = true
          cleanup()
          req?.destroy()
          response?.destroy()
          reject(new PetModelError(code))
        }
        const abort = () => fail('PET_MODEL_CANCELLED')
        const timer = setTimeout(() => fail('PET_MODEL_TIMEOUT'), 20_000)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) {
          abort()
          return
        }
        try {
          req = send(
            {
              protocol: 'http:',
              hostname: '127.0.0.1',
              port: 11434,
              family: 4,
              path: '/api/chat',
              method: 'POST',
              agent: false,
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Length': Buffer.byteLength(body, 'utf8'),
              },
            },
            (res) => {
              response = res
              res.on('error', () => fail('PET_MODEL_OFFLINE'))
              res.on('aborted', () => fail('PET_MODEL_OFFLINE'))
              if (settled) {
                res.destroy()
                return
              }
              if (res.statusCode !== 200) {
                fail(
                  res.statusCode === 404
                    ? 'PET_MODEL_UNAVAILABLE'
                    : res.statusCode === 429
                      ? 'PET_MODEL_BUSY'
                      : 'PET_MODEL_OFFLINE',
                )
                return
              }
              if (
                typeof res.headers['content-type'] !== 'string' ||
                !/^application\/json(?:\s*;[^\r\n]*)?$/i.test(
                  res.headers['content-type'],
                ) ||
                (res.headers['content-encoding'] !== undefined &&
                  res.headers['content-encoding'] !== 'identity')
              ) {
                fail('PET_MODEL_INVALID_RESPONSE')
                return
              }
              const length = res.headers['content-length']
              if (
                length !== undefined &&
                (typeof length !== 'string' ||
                  !/^\d+$/.test(length) ||
                  Number(length) > 65536)
              ) {
                fail('PET_MODEL_INVALID_RESPONSE')
                return
              }
              res.on('data', (chunk: unknown) => {
                if (settled) return
                if (!(chunk instanceof Uint8Array)) {
                  fail('PET_MODEL_INVALID_RESPONSE')
                  return
                }
                bytes += chunk.byteLength
                if (bytes > 65536) {
                  fail('PET_MODEL_INVALID_RESPONSE')
                  return
                }
                chunks.push(Buffer.from(chunk))
              })
              res.on('end', () => {
                if (settled) return
                if (signal.aborted) {
                  abort()
                  return
                }
                try {
                  if (length !== undefined && bytes !== Number(length))
                    throw Error()
                  const text = new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks),
                  )
                  JSON.parse(text)
                  settled = true
                  cleanup()
                  resolve(text)
                } catch {
                  fail('PET_MODEL_INVALID_RESPONSE')
                }
              })
            },
          )
          req.on('error', () =>
            fail(signal.aborted ? 'PET_MODEL_CANCELLED' : 'PET_MODEL_OFFLINE'),
          )
          if (settled) {
            req.destroy()
            return
          }
          req.end(body)
        } catch {
          fail('PET_MODEL_OFFLINE')
        }
      })
    } finally {
      busy = false
    }
  }
}
