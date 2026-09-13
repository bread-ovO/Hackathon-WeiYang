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
      !['oc_identity_a', 'oc_identity_b'].includes(
        params.get('container_id') ?? '',
      ) ||
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
    const second = params.get('container_id') === 'oc_identity_b'
    const chatId = second ? 'oc_identity_b' : 'oc_identity_a'
    const item = (
      externalId: string,
      text: string,
      offset: number,
      parentId?: string,
    ) => ({
      message_id: externalId,
      chat_id: chatId,
      create_time: String(start + offset),
      update_time: String(start + offset),
      sender: {
        sender_type: 'user',
        id_type: 'open_id',
        id: second ? 'ou_account_b' : 'ou_account_a',
      },
      ...(parentId ? { parent_id: parentId } : {}),
      deleted: false,
      body: { content: JSON.stringify({ text }) },
    })
    const body = {
      code: 0,
      data: {
        has_more: false,
        items: second
          ? [
              item('om_baseline_b', '第二个来源中的交付讨论记录', 2000),
              item(
                'om_plan_b',
                '截止时间改为 2026-09-25T18:00:00+08:00',
                3000,
                'om_baseline_b',
              ),
            ]
          : [item('om_baseline_a', '第一个来源中的交付讨论记录', 1000)],
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
