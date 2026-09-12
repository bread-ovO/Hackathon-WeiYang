import {
  parseCoreRequest,
  type CoreReply,
  type CoreRequest,
} from '@memo/contracts'
import {
  isTrustedSender,
  type RequestSender,
  type TrustedRenderer,
} from './security'

/** Keep all renderer requests on the same deny-by-default boundary. */
export function createRequestHandler(
  getRenderer: () => TrustedRenderer | null,
  pageURL: string,
  dispatch: (request: CoreRequest) => Promise<CoreReply<unknown>>,
) {
  return async (
    event: RequestSender,
    ...args: unknown[]
  ): Promise<CoreReply<unknown>> => {
    if (!isTrustedSender(event, getRenderer(), pageURL) || args.length !== 1) {
      return { ok: false, error: 'INVALID_REQUEST' }
    }
    let request: CoreRequest
    try {
      request = parseCoreRequest(args[0])
    } catch {
      return { ok: false, error: 'INVALID_REQUEST' }
    }
    try {
      return await dispatch(request)
    } catch {
      // Never return exception messages, which may contain paths or credentials.
      return { ok: false, error: 'INTERNAL_ERROR' }
    }
  }
}
