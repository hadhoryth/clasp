import { VERSION } from '../version.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { BridgeError, safeError } from '../errors.js';
import { parseRequest } from './anthropic.js';
import { translate } from './translate.js';
import { consumeResponse, type Emit } from './stream.js';
import { sse } from './sse.js';
import { detectRole, type Router } from '../routing/router.js';
import type { Config } from '../config.js';
export interface Upstream {
  request(path: '/responses', body: unknown, signal: AbortSignal): Promise<Response>;
}
function authorized(request: IncomingMessage, token: string) {
  const value =
    request.headers.authorization?.replace(/^Bearer /, '') ?? request.headers['x-api-key'];
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function readBody(req: IncomingMessage, max: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new BridgeError('Request body is too large.', 413);
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  const encoding = req.headers['content-encoding'];
  if (encoding === 'gzip') {
    try {
      body = gunzipSync(body, { maxOutputLength: max });
    } catch {
      throw new BridgeError('Invalid or oversized gzip request.', 400);
    }
  } else if (encoding && encoding !== 'identity')
    throw new BridgeError('Unsupported content encoding.', 415);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new BridgeError('Invalid request JSON.');
  }
}
function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}
export async function startGateway(options: {
  router: Router;
  upstream: Upstream;
  config: Config;
  token?: string;
  trace?: (line: string) => void;
  onClassifierFailure?: () => Promise<void>;
}) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const controllers = new Set<AbortController>();
  let temperatureWarned = false;
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on('close', abort);
    const timer = setTimeout(() => controller.abort(), options.config.gateway.timeout_ms);
    let ping: NodeJS.Timeout | undefined;
    let classifier = false;
    try {
      if (!authorized(req, token))
        throw new BridgeError('Invalid local session token.', 401, 'authentication_error');
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { status: 'ok', version: VERSION });
        return;
      }
      if (req.method === 'HEAD' && path === '/api/hello') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method === 'GET' && path === '/v1/models') {
        const data = options.router.models
          .filter((m) => m.available && !m.hidden)
          .map((m) => ({
            id: m.id,
            type: 'model',
            display_name: m.name,
            created_at: '1970-01-01T00:00:00Z',
            context_window: m.contextWindow,
            max_output_tokens: m.maxOutputTokens,
          }));
        json(res, 200, {
          data,
          has_more: false,
          first_id: data[0]?.id ?? null,
          last_id: data.at(-1)?.id ?? null,
        });
        return;
      }
      if (req.method === 'POST' && path === '/v1/messages/count_tokens')
        throw new BridgeError(
          "Exact token counting is unavailable for Codex models; use Claude Code's built-in estimate.",
          501,
          'api_error',
        );
      if (req.method !== 'POST' || path !== '/v1/messages')
        throw new BridgeError('Unsupported local gateway endpoint.', 404, 'not_found_error');
      const raw = await readBody(req, options.config.gateway.max_body_bytes);
      const request = parseRequest(raw);
      classifier = detectRole(request, req.headers) === 'classifier';
      let route = options.router.route(request, req.headers);
      const trace = () =>
        options.trace?.(
          JSON.stringify({
            time: new Date().toISOString(),
            role: route.role,
            requested: /^[\w.\-/\[\]]{1,160}$/.test(route.requested)
              ? route.requested
              : 'unrecognized',
            routed: route.model.id,
            effort: route.effort ?? null,
          }),
        );
      trace();
      if (request.temperature !== undefined && !temperatureWarned) {
        temperatureWarned = true;
        options.trace?.(
          'Codex uses its own sampling temperature; Messages temperature is not forwarded.',
        );
      }
      let translated = translate(request, route);
      let upstream: Response;
      try {
        upstream = await options.upstream.request('/responses', translated.body, controller.signal);
      } catch (error) {
        if (!(error instanceof BridgeError) || ![403, 404, 429, 503].includes(error.status))
          throw error;
        const fallbacks = options.config.fallback[route.model.id] ?? [];
        let response: Response | undefined;
        for (const id of fallbacks) {
          const model = options.router.models.find((m) => m.id === id && m.available);
          if (!model) continue;
          if (route.effort && !model.efforts.includes(route.effort)) continue;
          options.trace?.(`Configured fallback: ${route.model.id} -> ${model.id}`);
          route = { ...route, model };
          translated = translate(request, route);
          trace();
          try {
            response = await options.upstream.request(
              '/responses',
              translated.body,
              controller.signal,
            );
            break;
          } catch (next) {
            if (!(next instanceof BridgeError) || ![403, 404, 429, 503].includes(next.status))
              throw next;
          }
        }
        if (!response) throw error;
        upstream = response;
      }
      let emit: Emit = async () => {};
      if (request.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        emit = async (type, data) => {
          if (controller.signal.aborted)
            throw new BridgeError('Request cancelled.', 499, 'api_error');
          if (!res.write(sse(type, data))) await once(res, 'drain', { signal: controller.signal });
        };
        ping = setInterval(() => {
          if (!res.destroyed) res.write(sse('ping', { type: 'ping' }));
        }, 15000);
      }
      const message = await consumeResponse(upstream, request, translated.names, emit);
      if (request.stream) res.end();
      else json(res, 200, message);
    } catch (error) {
      const safe = controller.signal.aborted
        ? new BridgeError('Request cancelled or timed out.', 504, 'api_error')
        : safeError(error);
      options.trace?.(`Request failed (${safe.status}): ${safe.message}`);
      if (classifier && !controller.signal.aborted) {
        await options.onClassifierFailure?.().catch(() => {});
        options.trace?.(
          'Auto classifier unavailable. Action remains blocked; subsequent tool calls require manual approval.',
        );
      }
      const body = { type: 'error', error: { type: safe.type, message: safe.message } };
      if (!res.destroyed) {
        if (res.headersSent) {
          res.write(sse('error', body));
          res.end();
        } else
          json(res, safe.status, body, {
            'x-should-retry': 'false',
            ...(safe.retryAfter ? { 'retry-after': safe.retryAfter } : {}),
          });
      }
    } finally {
      clearTimeout(timer);
      if (ping) clearInterval(ping);
      controllers.delete(controller);
      res.off('close', abort);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BridgeError('Gateway could not bind localhost.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    async close() {
      for (const c of controllers) c.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
