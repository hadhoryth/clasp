export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type = 'invalid_request_error',
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}
export function safeError(error: unknown): BridgeError {
  return error instanceof BridgeError
    ? error
    : new BridgeError(
        'Bridge failure. Run clasp doctor; request and credential contents are not logged.',
        500,
        'api_error',
      );
}
