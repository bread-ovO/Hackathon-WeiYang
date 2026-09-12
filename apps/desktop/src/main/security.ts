export function isTrustedPage(actual:string, expected:string):boolean {
  try { const a=new URL(actual);const b=new URL(expected);return a.protocol===b.protocol && a.host===b.host && a.origin===b.origin && a.pathname===b.pathname && a.search===b.search } catch {return false}
}
