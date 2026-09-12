import Ajv from 'ajv'
import type { FromSchema } from 'json-schema-to-ts'

export const PLUGIN_HOST_API_VERSION = '1.0.0'
const stableVersionPattern =
  '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$'
const versionPattern =
  '^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$'
const identifier = {
  type: 'string',
  minLength: 2,
  maxLength: 64,
  pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
} as const
const pointer = {
  type: 'object',
  additionalProperties: false,
  required: ['pointer'],
  properties: {
    pointer: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      pattern: '^(?:/(?:[^~/\\u0000-\\u001f]|~[01])*)+$',
    },
  },
} as const
const commonRequired = [
  'id',
  'version',
  'schemaVersion',
  'sourceType',
  'displayName',
  'hostApiRange',
  'sampling',
  'mapping',
] as const
const properties = {
  id: identifier,
  version: { type: 'string', maxLength: 128, pattern: versionPattern },
  schemaVersion: { const: 1 },
  sourceType: { const: 'source' },
  displayName: { type: 'string', minLength: 1, maxLength: 80 },
  hostApiRange: {
    type: 'object',
    additionalProperties: false,
    required: ['minInclusive', 'maxExclusive'],
    properties: {
      minInclusive: { type: 'string', pattern: stableVersionPattern },
      maxExclusive: { type: 'string', pattern: stableVersionPattern },
    },
  },
  sampling: {
    type: 'object',
    additionalProperties: false,
    required: ['intervalSeconds', 'maxRecordsPerRun'],
    properties: {
      intervalSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
      maxRecordsPerRun: { type: 'integer', minimum: 1, maximum: 1000 },
    },
  },
  mapping: {
    type: 'object',
    additionalProperties: false,
    required: ['externalId', 'revision', 'occurredAt', 'role', 'text'],
    properties: {
      externalId: pointer,
      revision: pointer,
      occurredAt: pointer,
      text: pointer,
      role: {
        oneOf: [
          pointer,
          {
            type: 'object',
            additionalProperties: false,
            required: ['constant'],
            properties: {
              constant: { enum: ['user', 'assistant', 'tool', 'system'] },
            },
          },
        ],
      },
    },
  },
} as const
const directory = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'purpose'],
  properties: {
    id: identifier,
    purpose: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const
const credential = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'purpose'],
  properties: {
    id: identifier,
    purpose: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const

export const pluginManifestSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://bugu.local/schemas/source-plugin-manifest-v1.json',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: [...commonRequired, 'kind', 'permissions', 'transport'],
      properties: {
        ...properties,
        kind: { const: 'http-json' },
        permissions: {
          type: 'object',
          additionalProperties: false,
          required: ['domains', 'directories', 'credentials'],
          properties: {
            domains: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              uniqueItems: true,
              items: {
                type: 'string',
                maxLength: 253,
                pattern:
                  '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$',
              },
            },
            directories: { type: 'array', maxItems: 0, items: directory },
            credentials: { type: 'array', maxItems: 1, items: credential },
          },
        },
        transport: {
          type: 'object',
          additionalProperties: false,
          required: [
            'url',
            'method',
            'recordsPointer',
            'maxResponseBytes',
            'maxPages',
            'requestsPerMinute',
          ],
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 2048 },
            method: { const: 'GET' },
            recordsPointer: pointer.properties.pointer,
            maxResponseBytes: { type: 'integer', minimum: 1, maximum: 2097152 },
            maxPages: { type: 'integer', minimum: 1, maximum: 20 },
            requestsPerMinute: { type: 'integer', minimum: 1, maximum: 60 },
            credentialId: identifier,
            pagination: {
              type: 'object',
              additionalProperties: false,
              required: ['cursorPointer', 'cursorParameter'],
              properties: {
                cursorPointer: pointer.properties.pointer,
                cursorParameter: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 64,
                  pattern: '^[a-zA-Z][a-zA-Z0-9_]*$',
                },
              },
            },
          },
        },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: [...commonRequired, 'kind', 'permissions', 'transport'],
      properties: {
        ...properties,
        kind: { const: 'local-jsonl' },
        permissions: {
          type: 'object',
          additionalProperties: false,
          required: ['domains', 'directories', 'credentials'],
          properties: {
            domains: { type: 'array', maxItems: 0, items: { type: 'string' } },
            directories: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              items: directory,
            },
            credentials: { type: 'array', maxItems: 0, items: credential },
          },
        },
        transport: {
          type: 'object',
          additionalProperties: false,
          required: ['directoryId', 'file', 'maxFileBytes', 'maxLineBytes'],
          properties: {
            directoryId: identifier,
            file: {
              type: 'string',
              minLength: 7,
              maxLength: 256,
              pattern: '^(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\\.jsonl$',
            },
            maxFileBytes: { type: 'integer', minimum: 1, maximum: 16777216 },
            maxLineBytes: { type: 'integer', minimum: 1, maximum: 131072 },
          },
        },
      },
    },
  ],
} as const
export type SourceManifest = FromSchema<typeof pluginManifestSchema>
export interface ManifestIssue {
  path: string
  code: 'schema' | 'version' | 'permission' | 'transport'
  message: string
}
export type ManifestValidation =
  | { ok: true; manifest: SourceManifest }
  | { ok: false; issues: ManifestIssue[] }
const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true })
const schemaValidator = ajv.compile<SourceManifest>(pluginManifestSchema)
const stableVersion = new RegExp(stableVersionPattern)
function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number),
    b = right.split('.').map(Number)
  for (let index = 0; index < 3; index++)
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1
  return 0
}
export function isHostApiCompatible(
  range: SourceManifest['hostApiRange'],
  hostVersion = PLUGIN_HOST_API_VERSION,
): boolean {
  return (
    stableVersion.test(hostVersion) &&
    stableVersion.test(range.minInclusive) &&
    stableVersion.test(range.maxExclusive) &&
    compareVersions(range.minInclusive, range.maxExclusive) < 0 &&
    compareVersions(hostVersion, range.minInclusive) >= 0 &&
    compareVersions(hostVersion, range.maxExclusive) < 0
  )
}

/** Structural/semantic declaration validation only; it grants no filesystem/network access. */
export function validateSourceManifest(
  value: unknown,
  hostVersion = PLUGIN_HOST_API_VERSION,
): ManifestValidation {
  if (!schemaValidator(value))
    return {
      ok: false,
      issues: (schemaValidator.errors ?? []).slice(0, 32).map((error) => ({
        path: error.instancePath,
        code: 'schema',
        message: error.message ?? 'Invalid manifest',
      })),
    }
  const issues: ManifestIssue[] = []
  const issue = (at: string, code: ManifestIssue['code'], message: string) =>
    issues.push({ path: at, code, message })
  if (!isHostApiCompatible(value.hostApiRange, hostVersion))
    issue('/hostApiRange', 'version', '宿主 API 版本不兼容或版本区间无效。')
  const selectors = Object.entries(value.mapping).flatMap(
    ([field, selector]) =>
      Object.hasOwn(selector, 'pointer') && 'pointer' in selector
        ? [{ pointer: selector.pointer, path: `/mapping/${field}/pointer` }]
        : [],
  )
  if (value.kind === 'http-json') {
    selectors.push({
      pointer: value.transport.recordsPointer,
      path: '/transport/recordsPointer',
    })
    if (
      Object.hasOwn(value.transport, 'pagination') &&
      value.transport.pagination
    )
      selectors.push({
        pointer: value.transport.pagination.cursorPointer,
        path: '/transport/pagination/cursorPointer',
      })
  }
  for (const selected of selectors) {
    const segments = selected.pointer
      .slice(1)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (
      segments.some((part) =>
        ['__proto__', 'prototype', 'constructor'].includes(part),
      )
    )
      issue(selected.path, 'transport', 'JSON Pointer 不得访问原型相关字段。')
  }
  if (value.kind === 'http-json') {
    try {
      const raw = value.transport.url
      const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1]
      // WHATWG parsing normalizes encoded hosts, backslashes and whitespace. Reject
      // those spellings before parsing so permission review and requests agree.
      if (
        !authority ||
        /[%@]/.test(authority) ||
        /[\\\s\u0000-\u001f\u007f?#]/u.test(raw) ||
        /%(?![0-9a-f]{2})/i.test(raw)
      )
        issue(
          '/transport/url',
          'transport',
          'URL 必须使用明确的 HTTPS 域名，禁止歧义编码、反斜杠、空白、查询串和片段。',
        )
      const url = new URL(raw)
      // DNS answers, including public-looking aliases of private addresses, still
      // require runtime validation; this only rejects known local name forms.
      if (
        ['localhost', 'local', 'localdomain', 'home.arpa'].some(
          (domain) =>
            url.hostname === domain || url.hostname.endsWith('.' + domain),
        )
      )
        issue(
          '/transport/url',
          'permission',
          '本地网络域名不在 HTTP 插件的公网范围内。',
        )
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== '443') ||
        !value.permissions.domains.includes(url.hostname)
      )
        issue(
          '/transport/url',
          'permission',
          '需要与声明域名完全一致的 HTTPS URL，禁止用户信息、fragment 和非 443 端口。',
        )
      if (url.search)
        issue(
          '/transport/url',
          'transport',
          'v1 不接受静态查询串；分页游标由宿主添加，凭据由代理注入。',
        )
    } catch {
      issue('/transport/url', 'transport', '无效的 HTTPS URL。')
    }
    const declared = value.permissions.credentials[0]?.id
    const credentialId = Object.hasOwn(value.transport, 'credentialId')
      ? value.transport.credentialId
      : undefined
    if (credentialId !== declared)
      issue(
        '/transport/credentialId',
        'permission',
        '凭据槽位必须与声明相同；不得携带凭据值。',
      )
    if (
      value.transport.maxPages > 1 &&
      (!Object.hasOwn(value.transport, 'pagination') ||
        !value.transport.pagination)
    )
      issue(
        '/transport/pagination',
        'transport',
        '多页读取必须声明游标分页方式。',
      )
  } else {
    if (value.transport.directoryId !== value.permissions.directories[0]?.id)
      issue(
        '/transport/directoryId',
        'permission',
        '目录必须引用声明的授权槽位。',
      )
    if (value.transport.maxLineBytes > value.transport.maxFileBytes)
      issue(
        '/transport/maxLineBytes',
        'transport',
        '单行上限不能超过文件上限。',
      )
  }
  return issues.length
    ? { ok: false, issues }
    : { ok: true, manifest: structuredClone(value) }
}
export class InvalidSourceManifestError extends Error {
  constructor(readonly issues: ManifestIssue[]) {
    super('INVALID_SOURCE_MANIFEST')
    this.name = 'InvalidSourceManifestError'
  }
}
export function parseSourceManifest(
  value: unknown,
  hostVersion = PLUGIN_HOST_API_VERSION,
): SourceManifest {
  const result = validateSourceManifest(value, hostVersion)
  if (!result.ok) throw new InvalidSourceManifestError(result.issues)
  return result.manifest
}

export const HTTP_JSON_MANIFEST_EXAMPLE = {
  id: 'example-http',
  version: '1.0.0',
  schemaVersion: 1,
  sourceType: 'source',
  displayName: 'Example HTTP events',
  hostApiRange: { minInclusive: '1.0.0', maxExclusive: '2.0.0' },
  kind: 'http-json',
  permissions: {
    domains: ['api.example.com'],
    directories: [],
    credentials: [{ id: 'api-token', purpose: '只读获取用户授权的事件' }],
  },
  sampling: { intervalSeconds: 300, maxRecordsPerRun: 100 },
  transport: {
    url: 'https://api.example.com/events',
    method: 'GET',
    recordsPointer: '/items',
    maxResponseBytes: 1048576,
    maxPages: 5,
    requestsPerMinute: 12,
    credentialId: 'api-token',
    pagination: { cursorPointer: '/next_cursor', cursorParameter: 'cursor' },
  },
  mapping: {
    externalId: { pointer: '/id' },
    revision: { pointer: '/revision' },
    occurredAt: { pointer: '/created_at' },
    role: { pointer: '/role' },
    text: { pointer: '/content' },
  },
} as const
export const LOCAL_JSONL_MANIFEST_EXAMPLE = {
  id: 'example-local',
  version: '1.0.0',
  schemaVersion: 1,
  sourceType: 'source',
  displayName: 'Example local export',
  hostApiRange: { minInclusive: '1.0.0', maxExclusive: '2.0.0' },
  kind: 'local-jsonl',
  permissions: {
    domains: [],
    directories: [{ id: 'exports', purpose: '读取用户明确选择的导出目录' }],
    credentials: [],
  },
  sampling: { intervalSeconds: 300, maxRecordsPerRun: 100 },
  transport: {
    directoryId: 'exports',
    file: 'events.jsonl',
    maxFileBytes: 1048576,
    maxLineBytes: 131072,
  },
  mapping: {
    externalId: { pointer: '/id' },
    revision: { pointer: '/revision' },
    occurredAt: { pointer: '/created_at' },
    role: { constant: 'user' },
    text: { pointer: '/content' },
  },
} as const
