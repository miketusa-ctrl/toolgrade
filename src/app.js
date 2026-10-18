/**
 * ToolGrade Worker router. Never logs or stores submitted tool definitions; makes no outbound requests.
 * Pattern: DnsGuard (shared authenticate()/runCheck() for /api and /mcp) via MailAlign v0.1.1 (env-based, POST-only, free keys).
 * Routes: GET / (paste-and-grade), POST /api/grade, POST /api/keys, GET /api/health, POST /mcp, GET /llms.txt, GET /openapi.json,
 * GET /.well-known/mcp/server-card.json, GET /terms, GET /privacy, GET /robots.txt, GET /favicon.svg.
 */
import { extractTools, parseInput, gradeTools, GradeError, VERSION, MAX_INPUT_BYTES } from './lib/grade.js';
import { handleMcp, MCP_CORS } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard } from './lib/agentdocs.js';
import { homepage, termsPage, privacyPage, FAVICON } from './lib/page.js';
import { countVisitor, chargeDailyPool, chargeCounter, utcDay } from './lib/quota.js';
import { keyFromRequest, lookupKey, chargeKey, peekKey, issueKey, FREE_MONTHLY, _resetKeys } from './lib/keys.js';

export { VERSION };
/** Glama connector claim body (protocol step 4/4m). The account-wide token comes ONLY from the GLAMA_CLAIM Worker secret
 *  (`wrangler versions secret put GLAMA_CLAIM`); never hardcoded, never in [vars]. null when unset/empty → route returns 404. */
export function glamaClaimBody(env = {}) {
  const claim = typeof env.GLAMA_CLAIM === 'string' ? env.GLAMA_CLAIM.trim() : '';
  return claim ? JSON.stringify({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim }) : null;
}

export const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
export const API_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key',
  'access-control-expose-headers': 'retry-after, x-toolgrade-quota-remaining, x-toolgrade-tier',
  'access-control-max-age': '86400',
};
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
export function limitsFor(env = {}) {
  return {
    anonPerMin: int(env.CHECK_LIMIT_PER_MIN, 20),
    dailyPool: int(env.DAILY_CHECK_POOL, 5000),
    dailyKvWrites: int(env.DAILY_KV_WRITES, 150),
    maxBytes: MAX_INPUT_BYTES,
    freeMonthly: int(env.FREE_KEY_MONTHLY, FREE_MONTHLY),
    keysPerHour: int(env.KEYS_PER_IP_HOUR, 3),
    freeKeyPool: int(env.FREE_KEY_DAILY_POOL, 20000),
    mintPerDay: int(env.KEY_MINT_PER_DAY, 200),
  };
}

export function ipBucket(ip) { // IPv4 as is; IPv6 → its /64. Same output as workdayapi's.
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1);
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}

// Per-isolate sliding counter (MCP discovery cap, fallback when no ratelimit binding exists).
const mem = new Map();
export function memLimit(key, limit, windowMs, now = Date.now()) {
  if (mem.size > 5000) mem.clear();
  const e = mem.get(key);
  if (!e || now - e.t >= windowMs) { mem.set(key, { t: now, n: 1 }); return true; }
  return ++e.n <= limit;
}
export function _resetMem() { mem.clear(); _resetKeys(); }

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...API_CORS, ...SECURITY, ...headers },
});
export const apiError = (status, code, message, headers = {}) => json({ error: { code, message } }, status, headers);

/** Shared key gate for /api and /mcp. No key → anonymous; valid key → free; bad key → 401 (key never echoed). */
export async function authenticate(request, env) {
  const k = keyFromRequest(request);
  if (k === null) return { ok: true, tier: 'anonymous' };
  const bad = { ok: false, status: 401, code: 'invalid_key', message: 'API key not recognized. Send it as Authorization: Bearer tg_live_… or X-Api-Key, or omit it to use the anonymous tier.', headers: {} };
  if (k === 'malformed') return bad;
  const hash = await lookupKey(env, k);
  if (hash && typeof hash === 'object') return { ok: false, status: 503, code: 'unavailable', message: 'Key check is temporarily unavailable. Retry shortly, or omit the key to use the anonymous tier.', headers: { 'retry-after': '30' } };
  return hash ? { ok: true, tier: 'free', keyHash: hash } : bad;
}

/** Shared by POST /api/grade and MCP tools/call: input check → per-minute limiter → daily pool / key quota → grade. */
export async function runCheck({ input, auth = { tier: 'anonymous' }, env, ctx, ip, request }) {
  const L = limitsFor(env);
  // input = JSON text (REST body, MCP tools_json: MAX_INPUT_BYTES = 256 KiB) or an already-parsed value.
  const parsed = input !== null && typeof input === 'object';
  if (!parsed && (typeof input !== 'string' || !input.trim())) return { ok: false, status: 400, code: 'invalid_input', message: 'Send the JSON output of an MCP tools/list call: the full response, its result {"tools": [...]}, or an array of tools.', headers: {} };
  if (!parsed && new TextEncoder().encode(input).byteLength > MAX_INPUT_BYTES) return { ok: false, status: 413, code: 'too_large', message: `Tool definitions exceed ${MAX_INPUT_BYTES} bytes. Grade the list in parts.`, headers: {} };
  // Validate before any limiter or pool is charged, so bad input never costs quota.
  let extracted;
  try { extracted = extractTools(parsed ? input : parseInput(input)); } catch (e) {
    if (e instanceof GradeError) return { ok: false, status: e.httpStatus, code: e.code, message: e.message, headers: {} };
    throw e;
  }
  const key = auth.tier === 'free' ? `k:${auth.keyHash.slice(0, 32)}` : ipBucket(ip);
  let allowed = true;
  if (env.CHECK_LIMITER) { try { allowed = (await env.CHECK_LIMITER.limit({ key })).success; } catch { allowed = memLimit(`chk:${key}`, L.anonPerMin, 60_000); } }
  else allowed = memLimit(`chk:${key}`, L.anonPerMin, 60_000);
  if (!allowed) return { ok: false, status: 429, code: 'rate_limited', message: `Too many grades from your ${auth.tier === 'free' ? 'key' : 'IP'} (about ${L.anonPerMin} per minute).`, headers: { 'retry-after': '60' } };
  const monthly = () => ({ ok: false, status: 429, code: 'monthly_limit', message: `This key has used its ${L.freeMonthly} free grades for this month. It resets on the 1st (UTC); anonymous use still works without the key.`, headers: { 'x-toolgrade-tier': 'free' } });
  if (auth.tier === 'free') {
    // A key that is already over its monthly quota must not consume the shared free-key pool.
    const m = await peekKey(env, L, auth.keyHash);
    if (!m.ok) { const r = monthly(); r.headers['retry-after'] = String(m.retryAfter); return r; }
    const g = await chargeCounter(env, ctx, L, 'kpool', L.freeKeyPool, 25);
    if (!g.ok) return { ok: false, status: 429, code: 'pool_exhausted', message: 'The shared daily pool for free API keys is used up. It resets at 00:00 UTC.', headers: { 'retry-after': String(g.retryAfter), 'x-toolgrade-tier': 'free' } };
  }
  const pool = auth.tier === 'free' ? await chargeKey(env, ctx, L, auth.keyHash) : await chargeDailyPool(env, ctx, L);
  if (!pool.ok) {
    if (auth.tier === 'free') { const r = monthly(); r.headers['retry-after'] = String(pool.retryAfter); return r; }
    return { ok: false, status: 429, code: 'daily_limit', message: `The free daily pool (about ${L.dailyPool} anonymous grades per UTC day) is used up. It resets at 00:00 UTC. A free API key has its own monthly quota.`, headers: { 'retry-after': String(pool.retryAfter), 'x-toolgrade-tier': 'anonymous' } };
  }
  const body = gradeTools(extracted.tools, { source: extracted.source });
  if (request) countVisitor(request, env, ctx, ip, L);
  return { ok: true, body, headers: { 'x-toolgrade-quota-remaining': String(pool.remaining), 'x-toolgrade-tier': auth.tier }, cached: false };
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const isPublic = (env) => env.PUBLIC_LAUNCH === 'true';
const doc = (body, type, env, extra = {}) => new Response(body, {
  headers: { 'content-type': type, 'cache-control': 'public, max-age=3600', ...SECURITY, ...(isPublic(env) ? {} : { 'x-robots-tag': 'noindex, nofollow' }), ...extra },
});
const onlyGet = (request) => (['GET', 'HEAD'].includes(request.method) ? null
  : request.method === 'OPTIONS' ? new Response(null, { status: 204, headers: { allow: 'GET, HEAD, OPTIONS', ...API_CORS } })
    : new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD, OPTIONS', ...SECURITY } }));

export async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const noindex = isPublic(env) ? {} : { 'x-robots-tag': 'noindex, nofollow' };
  const withNoindex = (res) => { if (!isPublic(env)) res.headers.set('x-robots-tag', 'noindex, nofollow'); return res; };

  if (path === '/mcp') {
    const L = limitsFor(env);
    // Discovery cap: per-isolate memLimit (synchronous, as mcp.js expects) plus the MCP_LIMITER binding per request.
    if (env.MCP_LIMITER && request.method === 'POST') {
      let ok = true; try { ok = (await env.MCP_LIMITER.limit({ key: ipBucket(ip) })).success; } catch { /* fall back to memLimit */ }
      if (!ok) return withNoindex(new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Too many MCP requests from your IP. Retry in a minute.', data: { code: 'rate_limited', retryAfterSeconds: 60 } } }), { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '60', ...MCP_CORS, ...SECURITY } }));
    }
    return withNoindex(await handleMcp(request, env, ctx, {
      authenticate, runCheck, ip: ipBucket(ip), request, origin: url.origin, memLimit, security: SECURITY, cors: MCP_CORS,
      allowedOrigins: env.MCP_ALLOWED_ORIGINS, anonPerMin: L.anonPerMin,
    }));
  }
  if (path === '/api/grade') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
    if (request.method !== 'POST') return withNoindex(apiError(405, 'method_not_allowed', 'POST the tools/list JSON as the request body (application/json).', { allow: 'POST, OPTIONS' }));
    const text = await readCapped(request, MAX_INPUT_BYTES);
    if (text === null) return withNoindex(apiError(413, 'too_large', `Request body exceeds ${MAX_INPUT_BYTES} bytes. Grade the list in parts.`));
    // Auth before any work that charges quota; invalid input is rejected inside runCheck before limiters.
    const auth = await authenticate(request, env);
    if (!auth.ok) return withNoindex(apiError(auth.status, auth.code, auth.message, auth.headers));
    const r = await runCheck({ input: text, auth, env, ctx, ip, request });
    if (!r.ok) return withNoindex(apiError(r.status, r.code, r.message, r.headers));
    return withNoindex(json(r.body, 200, r.headers));
  }
  if (path === '/api/keys') {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
    if (request.method !== 'POST') return withNoindex(apiError(405, 'method_not_allowed', 'POST /api/keys (no body) to get a free API key.', { allow: 'POST, OPTIONS' }));
    const L = limitsFor(env); const bucket = ipBucket(ip);
    if (!memLimit(`issue:${bucket}`, L.keysPerHour, 3_600_000)) return withNoindex(apiError(429, 'rate_limited', `Too many new keys from your IP (about ${L.keysPerHour} per hour, best-effort). Try again later.`, { 'retry-after': '3600' }));
    if (env.CHECK_LIMITER) { let ok = true; try { ok = (await env.CHECK_LIMITER.limit({ key: bucket })).success; } catch { /* allow */ } if (!ok) return withNoindex(apiError(429, 'rate_limited', 'Too many requests from your IP. Retry in a minute.', { 'retry-after': '60' })); }
    const mint = await chargeCounter(env, ctx, L, 'mint', L.mintPerDay, 5);
    if (!mint.ok) return withNoindex(apiError(429, 'pool_exhausted', `Today's free key limit (about ${L.mintPerDay} new keys) is reached. Try again after 00:00 UTC; anonymous use still works.`, { 'retry-after': String(mint.retryAfter) }));
    const k = await issueKey(env, ctx, L);
    if (!k.ok) return withNoindex(apiError(503, 'unavailable', 'Key issuance is paused for today. Try again after 00:00 UTC; anonymous use still works.', { 'retry-after': '3600' }));
    return withNoindex(json({ key: k.key, plan: 'free', monthlyLimit: L.freeMonthly, note: 'Shown once. Only a hash of this key is stored; we cannot recover it. Send it as Authorization: Bearer <key> or X-Api-Key: <key>.' }, 201));
  }
  if (path === '/api/health') {
    const m = onlyGet(request); if (m) return m;
    return json({ ok: true, version: VERSION, day: utcDay() }, 200, noindex);
  }
  if (path === '/llms.txt') { const m = onlyGet(request); if (m) return m; return doc(llmsTxt(url.origin, limitsFor(env)), 'text/plain; charset=utf-8', env); }
  if (path === '/openapi.json') { const m = onlyGet(request); if (m) return m; return doc(JSON.stringify(openApiSpec(url.origin, limitsFor(env)), null, 2), 'application/json; charset=utf-8', env, { 'access-control-allow-origin': '*' }); }
  if (path === '/.well-known/mcp/server-card.json') { const m = onlyGet(request); if (m) return m; return doc(JSON.stringify(serverCard(url.origin, limitsFor(env)), null, 2), 'application/json; charset=utf-8', env, { 'access-control-allow-origin': '*' }); }
  if (path === '/terms') { const m = onlyGet(request); if (m) return m; return doc(termsPage(limitsFor(env)), 'text/html; charset=utf-8', env, { 'content-security-policy': CSP }); }
  if (path === '/privacy') { const m = onlyGet(request); if (m) return m; return doc(privacyPage(), 'text/html; charset=utf-8', env, { 'content-security-policy': CSP }); }
  if (path === '/.well-known/mcp-registry-auth') {
    // Official MCP Registry HTTP-domain ownership proof (DnsGuard pattern). PUBLIC key record only; 404 unless well-formed.
    const m = onlyGet(request); if (m) return m;
    const proof = String(env.MCP_REGISTRY_AUTH || '').trim();
    if (/^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(proof)) {
      return new Response(request.method === 'HEAD' ? null : `${proof}\n`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
    }
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } });
  }
  if (path === '/.well-known/glama.json') {
    // Glama connector ownership claim, served at /.well-known/glama.json. Set your own glama.ai claim token as the GLAMA_CLAIM Worker secret (or replace the placeholder, if present).
    const m = onlyGet(request); if (m) return m;
    const claim = glamaClaimBody(env);
    if (!claim) return new Response(request.method === 'HEAD' ? null : 'Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY } });
    return new Response(request.method === 'HEAD' ? null : claim, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*', ...SECURITY } });
  }
  if (path === '/robots.txt') {
    const m = onlyGet(request); if (m) return m;
    return doc(isPublic(env) ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n', 'text/plain; charset=utf-8', env);
  }
  if (path === '/favicon.svg' || path === '/favicon.ico') { const m = onlyGet(request); if (m) return m; return doc(FAVICON, 'image/svg+xml', env); }
  if (path === '/') {
    const m = onlyGet(request); if (m) return m;
    if (request.method === 'GET') countVisitor(request, env, ctx, ip, limitsFor(env));
    return doc(homepage(limitsFor(env)), 'text/html; charset=utf-8', env, { 'content-security-policy': CSP, 'cache-control': 'public, max-age=300' });
  }
  if (path.startsWith('/api/')) return withNoindex(apiError(404, 'not_found', 'Unknown API route. See /openapi.json.'));
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY, ...noindex } });
}
