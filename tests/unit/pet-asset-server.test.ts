import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { startAssetServer } from '../desktop/pet/asset-server'
import { symlinkOrSkip } from './helpers/symlink-or-skip'
let root: string, service: Awaited<ReturnType<typeof startAssetServer>>
beforeEach(async (ctx) => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'pet-assets-')))
  await mkdir(join(root, 'public'))
  await writeFile(join(root, 'public', 'model.json'), '{}')
  await writeFile(join(root, 'private.txt'), 'private')
  await symlinkOrSkip(ctx, join(root, 'private.txt'), join(root, 'public', 'link.json'))
  await symlinkOrSkip(ctx, root, join(root, 'public', 'linked-directory'))
  service = await startAssetServer(
    { '/verify.js': join(root, 'public', 'model.json') },
    [['/model/', join(root, 'public')]],
  )
})
afterEach(async () => {
  await new Promise<void>((done) => {
    service.server.close(() => done())
    service.server.closeAllConnections()
  })
  await rm(root, { recursive: true, force: true })
})
function get(
  path: string,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((done, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: service.port, path, method },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          done({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}
it('serves only explicit files and configured asset roots', async () => {
  expect(await get('/model/model.json')).toEqual({ status: 200, body: '{}' })
  expect(await get('/verify.js')).toEqual({ status: 200, body: '{}' })
  expect((await get('/private.txt')).status).toBe(404)
  expect((await get('/model/model.json', 'POST')).status).toBe(405)
})
it.each([
  '/model/../private.txt',
  '/model/%2e%2e/private.txt',
  '/model/%2e%2e%2fprivate.txt',
  '/model/link.json',
  '/model/linked-directory/private.txt',
  '/model/%zz',
  '/model/',
  '/model/..%5cprivate.txt',
  '/model/model.json?x=1',
  '//model/model.json',
])('rejects unsafe paths without crashing: %s', async (path) => {
  expect((await get(path)).status).toBe(404)
  expect((await get('/model/model.json')).status).toBe(200)
})
