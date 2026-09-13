/** Shared validation for the bounded account collector checkpoint and observed payload. */
export const githubAccountKinds = [
  'repository',
  'pull-request',
  'issue',
  'issue-comment',
  'review-comment',
] as const
export type GithubAccountKind = (typeof githubAccountKinds)[number]
export interface GithubAccountCursor {
  v: 1
  repositoryPage: number
  repositoryIndex: number
  kind: number
  page: number
}
export function parseGithubAccountCursor(raw: string): GithubAccountCursor {
  if (raw === '')
    return { v: 1, repositoryPage: 1, repositoryIndex: 0, kind: 0, page: 1 }
  if (typeof raw !== 'string' || raw.length > 256)
    throw Error('INVALID_GITHUB_CURSOR')
  const c = JSON.parse(raw) as GithubAccountCursor
  if (
    !c ||
    typeof c !== 'object' ||
    Object.keys(c).sort().join(',') !==
      'kind,page,repositoryIndex,repositoryPage,v' ||
    c.v !== 1 ||
    ![c.repositoryPage, c.page].every(
      (n) => Number.isSafeInteger(n) && n >= 1 && n <= 10000,
    ) ||
    !Number.isInteger(c.repositoryIndex) ||
    c.repositoryIndex < 0 ||
    c.repositoryIndex > 100 ||
    !Number.isInteger(c.kind) ||
    c.kind < 0 ||
    c.kind > 3
  )
    throw Error('INVALID_GITHUB_CURSOR')
  return c
}
export interface GithubAccountObservation {
  kind: 'github-account-observation'
  objectKind: GithubAccountKind
  repository: string
  repositoryId: number
  objectId: number
  number: number | null
  title: string
  body: string
  state: string | null
  url: string
  updatedAt: string
}
export function parseGithubAccountObservation(
  value: unknown,
): GithubAccountObservation {
  const fail = (): never => {
    throw Error('GITHUB_INVALID_RESPONSE')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const v = value as GithubAccountObservation
  if (
    Object.keys(v).sort().join(',') !==
      'body,kind,number,objectId,objectKind,repository,repositoryId,state,title,updatedAt,url' ||
    v.kind !== 'github-account-observation' ||
    !githubAccountKinds.includes(v.objectKind) ||
    typeof v.repository !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/.test(v.repository) ||
    v.repository.split('/').some((s) => s === '.' || s === '..') ||
    ![v.repositoryId, v.objectId].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    !(v.number === null || (Number.isSafeInteger(v.number) && v.number > 0)) ||
    typeof v.title !== 'string' ||
    v.title.length > 2048 ||
    typeof v.body !== 'string' ||
    v.body.length > 40000 ||
    /\0/.test(v.body + v.title) ||
    !(v.state === null || ['open', 'closed', 'merged'].includes(v.state)) ||
    typeof v.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    new Date(v.updatedAt).toISOString() !== v.updatedAt
  )
    return fail()
  const root = `https://github.com/${v.repository}`
  const path =
    v.objectKind === 'repository'
      ? ''
      : v.objectKind === 'pull-request'
        ? `/pull/${v.number}`
        : v.objectKind === 'issue'
          ? `/issues/${v.number}`
          : v.objectKind === 'issue-comment'
            ? `/issues/${v.number}#issuecomment-${v.objectId}`
            : `/pull/${v.number}#discussion_r${v.objectId}`
  // Issue comments on pull requests have /pull/ HTML URLs too.
  if (typeof v.url !== 'string') return fail()
  const url = v.url.toLowerCase()
  if (
    url !== root + path &&
    !(
      v.objectKind === 'review-comment' &&
      url === `${root}/pull/${v.number}#discussion-diff-${v.objectId}`
    ) &&
    !(
      v.objectKind === 'issue-comment' &&
      url === `${root}/pull/${v.number}#issuecomment-${v.objectId}`
    )
  )
    return fail()
  if (
    v.objectKind === 'repository'
      ? v.number !== null || v.objectId !== v.repositoryId
      : v.number === null
  )
    return fail()
  return structuredClone(v)
}
