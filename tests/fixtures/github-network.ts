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
    if (host !== 'api.github.com') throw Error('FIXTURE_UNEXPECTED_HOST')
    return [{ address: '93.184.216.34', family: 4 }]
  }
  https.request = (
    options: RequestOptions,
    callback: (response: unknown) => void,
  ) => {
    if (
      options.hostname !== 'api.github.com' ||
      options.method !== 'GET' ||
      (options.headers as Record<string, string>).Authorization !==
        `Bearer ${token}`
    )
      throw Error('FIXTURE_SCOPE_FAILED')
    const path = String(options.path)
    let body: unknown
    if (path === '/repos/fictional/desktop')
      body = { id: 987, full_name: 'fictional/desktop' }
    else if (path.startsWith('/repos/fictional/desktop/pulls?'))
      body = [
        {
          number: 7,
          title: '合成 GitHub 交付记录',
          html_url: 'https://github.com/fictional/desktop/pull/7',
          url: 'https://api.github.com/repos/fictional/desktop/pulls/7',
          state: 'closed',
          merged_at: '2026-09-13T00:00:00Z',
          updated_at: '2026-09-13T00:01:00Z',
          created_at: '2026-09-12T00:00:00Z',
          closed_at: '2026-09-13T00:00:00Z',
          draft: false,
          base: {
            ref: 'main',
            sha: 'a'.repeat(40),
            repo: { id: 987, full_name: 'fictional/desktop' },
          },
          head: {
            ref: 'feature',
            sha: 'b'.repeat(40),
            label: 'fictional:feature',
            repo: { full_name: 'fictional/desktop' },
          },
        },
      ]
    else throw Error('FIXTURE_UNPLANNED_PATH')
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
