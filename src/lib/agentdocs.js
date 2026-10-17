import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES, SERVER_INFO, instructions } from './mcp.js';
import { VERSION, MAX_INPUT_BYTES, MAX_TOOLS, TOKEN_NOTE } from './grade.js';
import { KEY_PREFIX } from './keys.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const PROD_ORIGIN = 'https://toolgrade.mike-tusa.workers.dev';
// Muse is named only as an example of an agent (ToolGrade is a plain MCP/HTTP tool); NOT_AFFILIATED covers the rest.
export const NOT_AFFILIATED = 'ToolGrade is not affiliated with Meta, Anthropic, OpenAI, Cursor or any other AI or MCP client vendor, and is not endorsed or sponsored by them.';
export const FOR_AGENTS = 'Useful for anyone building MCP servers for AI agents and assistants, for example Muse, Claude, ChatGPT or Cursor.';
export const NOTHING_STORED = 'Tool definitions you submit are parsed in memory and discarded when the response is sent. They are never written to storage, logs or analytics, and ToolGrade makes no network requests: it never connects to your server.';
export const mcpClientConfig = (origin) => ({ mcpServers: { toolgrade: { type: 'http', url: `${origin}/mcp` } } });

export const llmsTxt = (origin, L) => `# ToolGrade

> Grade MCP tool definitions for agent-readiness. Paste a tools/list response (or a tool array) and get a 0-100 score, an A-F grade, per-tool scores, findings with concrete fixes (missing or weak descriptions, untyped parameters, strings without maxLength, missing required / additionalProperties, missing annotations such as readOnlyHint, bad or duplicate names, outputSchema and enum problems, hidden characters and tool-poisoning patterns) and an estimated token cost of the definitions. Free paste tool, JSON API and a remote MCP server for AI agents. Pure parsing: no network calls, and your tool definitions are never stored.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tool \`${TOOLS[0].name}\` (tools: array of tool definitions, or tools_json: raw tools/list JSON text; optional include_raw). Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [MCP server card](${origin}/.well-known/mcp/server-card.json): static description of the MCP server and its tool
- ${FOR_AGENTS} ${NOT_AFFILIATED}

## JSON API

- \`POST ${origin}/api/grade\`: body = the JSON output of an MCP tools/list call (the full JSON-RPC response, its result \`{"tools": [...]}\`, a JSON-RPC batch, or a bare array of tools), application/json. Max ${MAX_INPUT_BYTES} bytes and ${MAX_TOOLS} tools. Response: { score (0-100), grade (A-F), summary { tools, critical, warning, info, source, verdictMeaning }, tokenEstimate { estimated: true, totalTokens, averagePerTool, largestTool, method, note }, tools [ { index, name, score, grade, estimatedTokens, critical, warning, info } ], findings [ { severity (critical|warning|info), code, tool, path, count, paths, message, fix } ], findingsOmitted, meta }. Optional key: \`Authorization: Bearer <key>\` or \`X-Api-Key: <key>\`. Response headers: X-ToolGrade-Tier (anonymous|free), X-ToolGrade-Quota-Remaining. Errors: { "error": { "code", "message" } } with 400 invalid_input / invalid_json / too_many_tools, 401 invalid_key, 503 unavailable, 404 not_found, 405 method_not_allowed, 413 too_large, 429 rate_limited / daily_limit / monthly_limit / pool_exhausted.
- Token cost is an ESTIMATE: ${TOKEN_NOTE}
- \`POST ${origin}/api/keys\` (no body, no sign-up, no email): returns 201 { key, plan: "free", monthlyLimit, note } once. Keys look like \`${KEY_PREFIX}\` + 32 hex. Only a SHA-256 hash of the key and a monthly counter are stored. About ${L.keysPerHour} new keys per hour per IP (best-effort, counted per server instance) and a global cap of about ${L.mintPerDay} new keys per day; 429 rate_limited / pool_exhausted, 503 unavailable when today's storage write budget is used.
- \`GET ${origin}/api/health\`: { ok, version, day }.

## Limits, keys and pricing

- Anonymous (no key): about ${L.anonPerMin} grades/min per IP and a shared pool of about ${L.dailyPool} grades per UTC day.
- Free key: about ${L.freeMonthly} grades per key per UTC calendar month, about ${L.anonPerMin}/min per key, not charged to the anonymous pool. All free keys together share a pool of about ${L.freeKeyPool} grades per UTC day (429 pool_exhausted), and about ${L.mintPerDay} new keys can be issued per day in total. No paid tier.
- Counts are approximate: counters are batched per server instance before being saved, so a key can occasionally get a few more than ${L.freeMonthly} in a month and the daily pools can run slightly over.
- The MCP endpoint uses the same keys and counters: each \`tools/call\` is one grade. Non-grade MCP messages don't count as grades, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After). Via MCP, tools_json text is capped at ${MAX_INPUT_BYTES} bytes like the JSON API, and the whole MCP request body (including a parsed tools array) at ${MAX_BODY_BYTES} bytes (about 264 KB).
- ${NOTHING_STORED}

## Optional

- [Privacy](${origin}/privacy)
- [Terms](${origin}/terms)
- Contact: ${CONTACT}
`;

const err = (desc) => ({ description: desc, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const rpc = (desc) => ({ description: desc, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 response (or batch array)' } } } });

export function openApiSpec(origin, L) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'ToolGrade', version: VERSION,
      description: `Grade MCP tool definitions for agent-readiness: 0-100 score, A-F grade, findings with fixes, estimated token cost. Pure parsing; your tool definitions are never stored; no network calls. Anonymous: about ${L.anonPerMin}/min per IP, shared daily pool about ${L.dailyPool}. Free key (POST /api/keys): about ${L.freeMonthly} grades/month. ${NOT_AFFILIATED}`,
      contact: { email: CONTACT },
    },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    paths: {
      '/api/grade': {
        post: {
          operationId: 'gradeTools', summary: 'Grade MCP tool definitions (tools/list output or tool array)',
          requestBody: { required: true, content: {
            'application/json': { schema: { description: `tools/list JSON-RPC response, its result {"tools": [...]}, a JSON-RPC batch, or an array of tools. Max ${MAX_INPUT_BYTES} bytes, ${MAX_TOOLS} tools.`, oneOf: [
              { type: 'object', properties: { tools: { type: 'array', maxItems: MAX_TOOLS, items: { type: 'object' } } }, required: ['tools'] },
              { type: 'object', properties: { jsonrpc: { type: 'string', const: '2.0' }, id: {}, result: { type: 'object', properties: { tools: { type: 'array', maxItems: MAX_TOOLS, items: { type: 'object' } } }, required: ['tools'] } }, required: ['result'] },
              { type: 'array', items: { type: 'object' } },
            ] } },
          } },
          responses: {
            200: { description: 'Grade report', headers: { 'X-ToolGrade-Quota-Remaining': { schema: { type: 'string' }, description: 'Approximate grades left (shared daily pool when anonymous, monthly quota with a key)' }, 'X-ToolGrade-Tier': { schema: { type: 'string', enum: ['anonymous', 'free'] } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Report' } } } },
            400: err('invalid_input, invalid_json or too_many_tools (rejected before rate limits or the daily pool are charged)'), 401: err('invalid_key'), 413: err('too_large'),
            429: { ...err('rate_limited, daily_limit (anonymous), monthly_limit or pool_exhausted (key; counts are approximate, batched per instance)'), headers: { 'Retry-After': { schema: { type: 'string' } } } },
            500: err('internal_error'), 503: { ...err('unavailable: key check temporarily failed'), headers: { 'Retry-After': { schema: { type: 'string' } } } },
          },
        },
        get: { operationId: 'gradeGetNotAllowed', summary: 'Not supported (POST the JSON body)', responses: { 405: err('method_not_allowed') } },
      },
      '/api/keys': {
        post: {
          operationId: 'issueKey', summary: 'Issue a free API key (no sign-up, no email). The key is shown once.', security: [{}],
          responses: {
            201: { description: 'New key', content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string', pattern: '^tg_live_[0-9a-f]{32}$' }, plan: { type: 'string', const: 'free' }, monthlyLimit: { type: 'integer' }, note: { type: 'string' } }, required: ['key', 'plan', 'monthlyLimit'] } } } },
            429: { ...err(`rate_limited (about ${L.keysPerHour} new keys per hour per IP, best-effort) or pool_exhausted (global cap of about ${L.mintPerDay} new keys per day)`), headers: { 'Retry-After': { schema: { type: 'string' } } } },
            503: err('unavailable: key issuance paused until the daily storage write budget resets'),
          },
        },
        get: { operationId: 'issueKeyGetNotAllowed', summary: 'Not supported', responses: { 405: err('method_not_allowed') } },
      },
      '/.well-known/mcp/server-card.json': { get: { operationId: 'serverCard', summary: 'Static MCP server card (same tools as tools/list)', responses: { 200: { description: 'Server card', content: { 'application/json': { schema: { type: 'object' } } } } } } },
      '/api/health': { get: { operationId: 'health', summary: 'Health and version', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, day: { type: 'string' } } } } } } } } },
      '/mcp': {
        post: {
          operationId: 'mcp', summary: 'Remote MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless)',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: `JSON-RPC 2.0 request, notification or batch (max 10, at most one tools/call). Max ${MAX_BODY_BYTES} bytes.` } } } },
          responses: { 200: rpc('JSON-RPC result'), 202: { description: 'Notification or client response accepted (empty body)' }, 400: rpc('Parse error, invalid request or protocol/header mismatch'), 401: rpc('Invalid API key (data.code invalid_key; no WWW-Authenticate)'), 403: rpc('Origin not allowed'), 404: rpc('Method not found (2026-07-28 requests)'), 413: rpc('Body too large'), 429: rpc('Too many MCP requests (Retry-After)'), 500: { description: 'Internal error' }, 503: { description: 'Temporarily unavailable' } },
        },
        get: { operationId: 'mcpGet', summary: 'Not supported (no SSE stream)', responses: { 405: { description: 'Method not allowed', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } } } } },
        delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: { Allow: { schema: { type: 'string', const: 'POST, OPTIONS' } } } } } },
      },
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Free API key from POST /api/keys' }, apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', enum: ['invalid_input', 'invalid_json', 'too_many_tools', 'invalid_key', 'too_large', 'rate_limited', 'daily_limit', 'monthly_limit', 'pool_exhausted', 'unavailable', 'method_not_allowed', 'not_found', 'internal_error'] }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] },
        Finding: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'warning', 'info'] }, code: { type: 'string' }, tool: { type: ['string', 'null'], description: 'Tool name from the input (untrusted); null for server-wide findings' }, path: { type: 'string' }, count: { type: 'integer' }, paths: { type: 'array', items: { type: 'string' } }, message: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'code', 'tool', 'message', 'fix'] },
        ToolRow: { type: 'object', properties: { index: { type: 'integer' }, name: { type: 'string' }, score: { type: 'integer' }, grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] }, estimatedTokens: { type: 'integer' }, critical: { type: 'integer' }, warning: { type: 'integer' }, info: { type: 'integer' } }, required: ['index', 'name', 'score', 'grade', 'estimatedTokens'] },
        Report: { type: 'object', properties: {
          score: { type: 'integer', minimum: 0, maximum: 100 },
          grade: { type: 'string', enum: ['A', 'B', 'C', 'D', 'F'] },
          summary: { type: 'object', properties: { tools: { type: 'integer' }, critical: { type: 'integer' }, warning: { type: 'integer' }, info: { type: 'integer' }, source: { type: 'string', enum: ['array', 'jsonrpc_batch', 'jsonrpc_response', 'tools_list_result', 'single_tool'] }, verdictMeaning: { type: 'string' } } },
          tokenEstimate: { type: 'object', description: 'ESTIMATE of definition token cost', properties: { estimated: { type: 'boolean', const: true }, totalTokens: { type: 'integer' }, averagePerTool: { type: 'integer' }, largestTool: { type: 'object' }, method: { type: 'string' }, note: { type: 'string' } } },
          tools: { type: 'array', items: { $ref: '#/components/schemas/ToolRow' } },
          findings: { type: 'array', items: { $ref: '#/components/schemas/Finding' } },
          findingsOmitted: { type: 'integer' },
          meta: { type: 'object', properties: { version: { type: 'string' }, stored: { type: 'boolean', const: false }, networkLookups: { type: 'boolean', const: false }, maxTools: { type: 'integer' } } },
        }, required: ['score', 'grade', 'summary', 'tokenEstimate', 'tools', 'findings', 'meta'] },
      },
    },
  };
}

/** Static MCP server card (SEP-1649 shape; Smithery scan fallback). Generated from the same TOOLS as tools/list. */
export function serverCard(origin, L) {
  return {
    serverInfo: SERVER_INFO,
    description: `Grade MCP tool definitions for agent-readiness: 0-100 score, A-F grade, findings with concrete fixes, estimated token cost. Pure parsing; your tool definitions are never stored. Anonymous: about ${L.anonPerMin} grades per minute per IP; free key: about ${L.freeMonthly} per month.`,
    homepage: `${origin}/`,
    contact: { email: CONTACT },
    transport: { type: 'streamable-http', url: `${origin}/mcp` },
    protocolVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false, schemes: ['bearer', 'x-api-key'], keyUrl: `${origin}/#key` },
    instructions: instructions(L.anonPerMin),
    tools: TOOLS,
  };
}
