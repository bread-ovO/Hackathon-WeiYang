import { parseCoreRequest } from '@memo/contracts'
import { describe, it, expect } from 'vitest'
import {
  githubObjectUrl,
  githubObjectLinks,
  describesFeedback,
} from '@memo/domain'
describe('delivery URL identity and feedback cues', () => {
  it('normalizes only explicit GitHub object URLs', () => {
    expect(githubObjectUrl('https://github.com/Example/Demo/issues/12')).toBe(
      'https://github.com/example/demo/issues/12',
    )
    for (const s of [
      'https://github.com.evil/x/y/pull/1',
      'http://github.com/a/b/pull/1',
      'https://github.com/a/../pull/1',
      'https://github.com/a/b/pull/0',
      'https://github.com/a/b/pull/9007199254740992',
      'https://github.com/a/b/pull/1/extra',
    ])
      expect(githubObjectUrl(s)).toBeNull()
    expect(
      githubObjectLinks(
        '目标 https://github.com/a/b/issues/12，完成 https://github.com/a/b/pull/3',
      ),
    ).toHaveLength(2)
    expect(githubObjectLinks('https://github.com/a/b/pull/12evil')).toEqual([])
  })
  it('requires affirmative feedback language', () => {
    expect(describesFeedback('已反馈 https://github.com/a/b/pull/3')).toBe(true)
    for (const text of [
      '尚未反馈链接',
      '准备发送 PR 链接：',
      '如果可以请查看',
      '取消反馈链接',
      '延期后已反馈',
      '任务完成了',
    ])
      expect(describesFeedback(text)).toBe(false)
  })
})

it('delivery IPC rejects missing fences and injected privilege fields', () => {
  const request = {
    method: 'workspace.completeDelivery',
    projectId: 'p',
    taskId: 't',
    expectedTaskVersion: 1,
    expectedCriteriaVersion: 1,
    expectedManualVersion: 0,
    expectedDigest: 'a'.repeat(64),
  }
  expect(parseCoreRequest(request)).toEqual(request)
  for (const value of [
    { ...request, expectedDigest: 'x' },
    { ...request, expectedTaskVersion: -1 },
    { ...request, actor: 'system' },
    { ...request, canComplete: true },
  ])
    expect(() => parseCoreRequest(value)).toThrow()
})
