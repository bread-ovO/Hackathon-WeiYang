import { EventEmitter } from 'node:events'
const http = require('node:http')
let bodies: string[] = []
let mode = 'success'
export function setMode(next: string) {
  mode = next
}
export function install() {
  bodies = []
  http.request = (options: any, callback: Function) => {
    if (
      options.hostname !== '127.0.0.1' ||
      options.port !== 11434 ||
      options.path !== '/api/chat' ||
      options.method !== 'POST'
    )
      throw Error('UNEXPECTED_MODEL_DESTINATION')
    let destroyed = false
    const req = Object.assign(new EventEmitter(), {
      destroy() {
        destroyed = true
        return req
      },
      end(body: string) {
        bodies.push(body)
        if (mode === 'wait') return req
        queueMicrotask(() => {
          if (destroyed) return
          const input = JSON.parse(body)
          const candidates = JSON.parse(input.messages[1].content).candidates
          const res = Object.assign(new EventEmitter(), {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            complete: false,
            destroy() {
              destroyed = true
              return res
            },
          })
          callback(res)
          if (destroyed) return
          res.emit(
            'data',
            Buffer.from(
              mode === 'invalid'
                ? '{}'
                : JSON.stringify({
                    done: true,
                    message: {
                      role: 'assistant',
                      content: JSON.stringify({
                        ref: candidates[0].ref,
                        template: 'review',
                      }),
                    },
                  }),
            ),
          )
          res.complete = true
          res.emit('end')
        })
        return req
      },
    })
    return req
  }
}
export function stats() {
  return [...bodies]
}
