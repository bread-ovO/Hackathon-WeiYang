/** Host-provided HTTP capability. Adapters cannot select a network implementation or follow redirects. */
export interface SourceHttpResponse {
  status: number
  headers: Record<string,string>
  body: unknown
}
export type SourceHttpTransport = (input:{
  url:string
  allowedDomain:string
  bearerToken:string
  signal:AbortSignal
  headers?:Record<string,string>
})=>Promise<SourceHttpResponse>
