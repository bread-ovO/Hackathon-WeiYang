/** Test-process-only OS boundary replacement. Never imported or bundled by the app. */
import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
const dns = require('node:dns/promises')
const https = require('node:https')
let restore: (() => void) | undefined
let calls: string[] = []
export function install(token: string) {
  if (restore) throw Error('FIXTURE_ALREADY_INSTALLED')
  const lookup = dns.lookup,
    request = https.request
  calls = []
  dns.lookup = async (host: string) => {
    if (host !== 'open.feishu.cn') throw Error('FIXTURE_UNEXPECTED_HOST')
    return [{ address: '93.184.216.34', family: 4 }]
  }
  https.request = (
    options: RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    if (
      options.hostname !== 'open.feishu.cn' ||
      options.method !== 'GET' ||
      (options.headers as Record<string, string>).Authorization !==
        `Bearer ${token}`
    )
      throw Error('FIXTURE_SCOPE_FAILED')
    const path = String(options.path)
    const url = new URL(path, 'https://open.feishu.cn')
    const params = url.searchParams
    if (
      url.pathname !== '/open-apis/im/v1/messages' ||
      params.get('container_id') !== 'oc_desktop' ||
      params.get('sort_type') !== 'ByCreateTimeAsc' ||
      params.get('page_size') !== '50'
    )
      throw Error('FIXTURE_UNPLANNED_SCOPE')
    const start = Number(params.get('start_time')) * 1000
    const end = Number(params.get('end_time')) * 1000
    const page = params.get('page_token') ?? ''
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start >= end ||
      !['', 'next-page'].includes(page)
    )
      throw Error('FIXTURE_UNPLANNED_WINDOW')
    const body = {
      code: 0,
      data: {
        has_more: !page,
        ...(!page ? { page_token: 'next-page' } : {}),
        items: [
          {
            message_id: page ? 'om_bot' : 'om_human',
            chat_id: 'oc_desktop',
            create_time: String(start + 1000),
            update_time: String(start + 1000),
            sender: { sender_type: page ? 'app' : 'user' },
            deleted: false,
            body: {
              content: JSON.stringify({
                text: page ? '我会完成机器人示例' : '我会完成飞书连接测试',
              }),
            },
          },
        ],
      },
    }
    calls.push(path)
    let destroyed = false
    const req = Object.assign(new EventEmitter(), {
      destroy() {
        destroyed = true
        return req
      },
      end() {
        queueMicrotask(() => {
          if (destroyed) return
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
          res.emit('data', Buffer.from(JSON.stringify(body)))
          res.complete = true
          res.emit('end')
        })
        return req
      },
    })
    return req
  }
  restore = () => {
    dns.lookup = lookup
    https.request = request
    restore = undefined
  }
}
export function stats() {
  return { paths: [...calls] }
}
export function dispose() {
  restore?.()
}
