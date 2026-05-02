import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Single error handler. CLAUDE.md says: no per-await try/catch,
 * errors bubble to here, here decides what the client sees.
 *
 * Shape: { error: { code, message, details? } } with the right
 * HTTP status. Server errors (>= 500) get logged with the request
 * context; client errors (4xx) do not.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500

    if (status >= 500) {
      req.log.error({ err, url: req.url, method: req.method }, 'unhandled error')
    }

    // Map well-known status codes to semantic codes when the
    // upstream error didn't supply one. Today the only entry is
    // 429 from `@fastify/rate-limit`, which throws a plain Error
    // with a `statusCode` but no machine-readable `code`. Centralising
    // the mapping here means clients can branch on
    // `error.code === 'rate_limited'` instead of magic-numbering 429.
    const fallbackCode =
      status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'bad_request'

    void reply.status(status).send({
      error: {
        code: err.code ?? fallbackCode,
        message: status >= 500 ? 'Internal server error' : err.message,
        ...(err.validation ? { details: err.validation } : {}),
      },
    })
  })

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    void reply.status(404).send({
      error: {
        code: 'not_found',
        message: `Route ${req.method} ${req.url} not found`,
      },
    })
  })
}
