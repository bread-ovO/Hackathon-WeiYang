/** URL identity only. No fuzzy title matching and no model judgement. */
export function githubObjectUrl(value: string): string | null {
  const m =
    /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9_.-]{1,100})\/(issues|pull)\/([1-9][0-9]*)$/i.exec(
      value,
    )
  if (!m || ['.', '..'].includes(m[2]!) || !Number.isSafeInteger(Number(m[4])))
    return null
  return `https://github.com/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}/${m[3]!.toLowerCase()}/${m[4]}`
}
export function githubObjectLinks(text: string): string[] {
  return [
    ...new Set(
      (
        text.match(
          /https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+\/(?:issues|pull)\/[1-9][0-9]*(?![0-9a-z_/])/gi,
        ) ?? []
      )
        .map(githubObjectUrl)
        .filter((s): s is string => s !== null),
    ),
  ]
}
export function describesFeedback(text: string): boolean {
  return (
    !/没|未|不|稍后|准备|计划|将|会|如果|可能|失败|取消|改期|延期/.test(text) &&
    /(?:已(?:经)?(?:提交|反馈|发出|发送)|这是.{0,12}PR|PR\s*(?:链接|地址)\s*[:：]|请(?:查收|查阅|查看)|反馈链接)/i.test(
      text,
    )
  )
}
