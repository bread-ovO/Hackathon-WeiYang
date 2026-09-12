import { createServer } from 'node:http'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.moc3': 'application/octet-stream',
  '.png': 'image/png',
  '.vert': 'text/plain',
  '.frag': 'text/plain',
}
export async function startAssetServer(
  exact: Record<string, string>,
  routes: [string, string][],
) {
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end()
        return
      }
      const raw = req.url ?? ''
      if (
        !raw.startsWith('/') ||
        raw.startsWith('//') ||
        raw.includes('?') ||
        raw.includes('#') ||
        /[\\\u0000-\u001f\u007f]/u.test(raw)
      )
        throw new Error('path')
      const name = decodeURIComponent(raw)
      if (
        /[\\\u0000-\u001f\u007f]/u.test(name) ||
        name.split('/').some((x) => x === '.' || x === '..')
      )
        throw new Error('path')
      let file: string | undefined = Object.hasOwn(exact, name)
        ? resolve(exact[name]!)
        : undefined
      if (!file) {
        const match = routes.find(([prefix]) => name.startsWith(prefix))
        if (!match) throw new Error('route')
        const root = resolve(match[1])
        file = resolve(root, name.slice(match[0].length))
        if (!file.startsWith(root + sep)) throw new Error('escape')
      }
      // Reject links in every component (including configured roots), not only the final file.
      let current = resolve(file)
      while (true) {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('symlink')
        const parent = resolve(current, '..')
        if (parent === current) break
        current = parent
      }
      if ((await realpath(file)) !== file || !(await lstat(file)).isFile())
        throw new Error('file')
      const bytes = await readFile(file)
      res.writeHead(200, {
        'content-type': mime[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('NO_TEST_PORT')
  return { server, port: address.port }
}
