import { CONTACT, NOT_AFFILIATED, FOR_AGENTS, NOTHING_STORED } from './agentdocs.js';
import { VERSION, MAX_TOOLS, TOKEN_NOTE } from './grade.js';
import { SAMPLE_NEEDS_WORK, SAMPLE_GOOD } from './samples.js';

export const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#4338ca"/><text x="16" y="22" font-family="monospace" font-size="15" font-weight="bold" fill="#fff" text-anchor="middle">A+</text></svg>';
export const CANONICAL = 'https://toolgrade.mike-tusa.workers.dev/';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// JSON for an inline <script> data block: escape "<" so "</script>" can never appear.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

export const homepage = (L) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ToolGrade: grade your MCP tool definitions for AI agents</title>
<meta name="description" content="Paste an MCP tools/list response and get a 0-100 agent-readiness score, A-F grade, concrete fixes (descriptions, types, maxLength, required, additionalProperties, annotations, names) and an estimated token cost. Free, no sign-up, your tool definitions are never stored. JSON API and MCP server.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${CANONICAL}">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<link rel="service-desc" type="application/json" href="/openapi.json" title="OpenAPI 3.1">
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#f8fafc}.wrap{max-width:900px;margin:0 auto;padding:16px}
h1{font-size:1.6rem;margin:.4em 0}textarea{width:100%;box-sizing:border-box;min-height:280px;font:13px/1.4 ui-monospace,monospace;padding:8px;border:1px solid #cbd5e1;border-radius:6px}
button{background:#4338ca;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:1rem;cursor:pointer}button.alt{background:#e2e8f0;color:#111;padding:6px 10px;font-size:.85rem}
.small{font-size:.85rem;color:#475569}pre{background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;overflow-x:auto}
.score{font-size:2.2rem;font-weight:700}.g-A{color:#15803d}.g-B{color:#65a30d}.g-C{color:#ca8a04}.g-D{color:#ea580c}.g-F{color:#dc2626}
.iss{border-left:4px solid #94a3b8;padding:4px 8px;margin:6px 0;background:#fff}.critical{border-color:#dc2626}.warning{border-color:#d97706}.info{border-color:#2563eb}
.fix{color:#334155;font-size:.9rem}table{border-collapse:collapse;font-size:.85rem;width:100%}td,th{border:1px solid #e2e8f0;padding:3px 5px;text-align:left;word-break:break-word}
code{font-family:ui-monospace,monospace;word-break:break-word}footer{border-top:1px solid #e2e8f0;margin-top:24px}
@media (max-width:560px){#mcp-config{white-space:pre-wrap;word-break:break-all}}
</style></head><body>
<main class="wrap">
<h1>ToolGrade</h1>
<p>Grade your MCP server's tool definitions the way an AI agent sees them. Paste the JSON from a <code>tools/list</code> call (the full response, its <code>result</code>, or just the array of tools). ToolGrade returns a 0-100 agent-readiness score, an A-F grade, a score per tool, and findings with concrete fixes: missing or weak descriptions, untyped parameters, strings without <code>maxLength</code>, missing <code>required</code> / <code>additionalProperties</code>, missing annotations such as <code>readOnlyHint</code>, bad or duplicate names, <code>outputSchema</code> and enum problems. It also gives an <strong>estimated</strong> token cost of the definitions. It only parses what you paste: it never connects to your server, and your tool definitions are never stored.</p>
<form id="f"><label for="in" class="small">tools/list JSON (max ${Math.round(L.maxBytes / 1024)} KB, ${MAX_TOOLS} tools)</label>
<p class="small">Load a sample: <button type="button" class="alt" id="s-bad">Needs work</button> <button type="button" class="alt" id="s-good">Agent-ready</button></p>
<textarea id="in" spellcheck="false">${esc(JSON.stringify(SAMPLE_NEEDS_WORK, null, 2))}</textarea>
<p><button type="submit">Grade tools</button> <span id="st" class="small" role="status"></span></p></form>
<div id="out" aria-live="polite"></div>

<section id="api"><h2>JSON API</h2>
<pre><code>curl -s -X POST 'https://toolgrade.mike-tusa.workers.dev/api/grade' \\
  -H 'content-type: application/json' --data-binary @tools-list.json</code></pre>
<p class="small">No key needed: about ${L.anonPerMin} grades per minute per IP from a shared daily pool. Token figures are estimates (${esc(TOKEN_NOTE)}) <a href="/openapi.json">OpenAPI 3.1 spec</a></p></section>

<section id="key"><h2>Free API key</h2>
<p class="small">No sign-up and no email. A key gives you about ${L.freeMonthly} grades per month of your own, outside the shared pool. Send it as <code>Authorization: Bearer &lt;key&gt;</code> or <code>X-Api-Key: &lt;key&gt;</code> (MCP clients: add it as a header). The key is shown once; we keep only a hash of it, so it can't be recovered.</p>
<p><button type="button" id="getkey">Get a free key</button> <code id="keyout"></code></p></section>

<section id="agents"><h2>For AI agents (MCP)</h2>
<p>ToolGrade is also a remote <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol</a> (MCP) server with one read-only tool, <code>grade_tools</code>, so a coding agent can grade the server it is building. ${esc(FOR_AGENTS)} Most MCP clients accept this config; some use a different format (for example, VS Code uses a <code>servers</code> key). Clients with a settings screen just need the URL <code>https://toolgrade.mike-tusa.workers.dev/mcp</code>.</p>
<pre><code id="mcp-config">{ "mcpServers": { "toolgrade": { "type": "http", "url": "https://toolgrade.mike-tusa.workers.dev/mcp" } } }</code></pre>
<p class="small">With a free key, add <code>"headers": { "Authorization": "Bearer &lt;key&gt;" }</code> to the server entry (exact field name depends on the client). Machine-readable docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI 3.1 spec</a> · <a href="/.well-known/mcp/server-card.json">MCP server card</a>. Checks follow the <a href="https://modelcontextprotocol.io/specification/2025-11-25/server/tools" target="_blank" rel="noopener noreferrer">MCP tools specification</a> plus common client limits. ${esc(NOT_AFFILIATED)}</p></section>

<section id="privacy"><h2>Privacy</h2>
<p class="small">${esc(NOTHING_STORED)} <a href="/privacy">Full privacy notice</a>.</p></section>
</main>
<footer class="wrap small"><p>${esc(NOT_AFFILIATED)}</p>
<p>ToolGrade v${VERSION} · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p></footer>
<script type="application/json" id="samples">${jsonForScript({ bad: SAMPLE_NEEDS_WORK, good: SAMPLE_GOOD })}</script>
<script>
document.getElementById('mcp-config').textContent = JSON.stringify({ mcpServers: { toolgrade: { type: 'http', url: location.origin + '/mcp' } } }, null, 2);
const f = document.getElementById('f'), out = document.getElementById('out'), st = document.getElementById('st'), ta = document.getElementById('in');
const S = JSON.parse(document.getElementById('samples').textContent);
document.getElementById('s-bad').addEventListener('click', () => { ta.value = JSON.stringify(S.bad, null, 2); });
document.getElementById('s-good').addEventListener('click', () => { ta.value = JSON.stringify(S.good, null, 2); });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
document.getElementById('getkey').addEventListener('click', async () => {
  const o = document.getElementById('keyout'); o.textContent = '…';
  try { const r = await fetch('/api/keys', { method: 'POST' }); const j = await r.json(); o.textContent = r.ok ? j.key + '  (copy it now; ' + j.monthlyLimit + '/month)' : ((j.error && j.error.message) || 'Error'); } catch { o.textContent = 'Request failed.'; }
});
f.addEventListener('submit', async (ev) => {
  ev.preventDefault(); st.textContent = 'Grading…'; out.replaceChildren();
  try {
    const r = await fetch('/api/grade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ta.value });
    const j = await r.json(); st.textContent = '';
    if (!r.ok) { out.append(el('p', 'iss critical', (j.error && j.error.message) || 'Error')); return; }
    const h = el('p', ''); h.append(el('span', 'score g-' + j.grade, j.score + '/100 · ' + j.grade)); out.append(h);
    out.append(el('p', 'small', j.summary.verdictMeaning));
    out.append(el('p', '', 'Estimated token cost of these definitions: ~' + j.tokenEstimate.totalTokens + ' tokens (' + j.summary.tools + ' tool(s), ~' + j.tokenEstimate.averagePerTool + ' each). ' + j.tokenEstimate.note));
    const t = el('table'); const hr = el('tr'); for (const x of ['#', 'Tool', 'Score', 'Grade', 'Est. tokens', 'Crit / Warn / Info']) hr.append(el('th', '', x)); t.append(hr);
    for (const x of j.tools) { const tr = el('tr'); for (const v of [x.index, x.name, x.score, x.grade, '~' + x.estimatedTokens, x.critical + ' / ' + x.warning + ' / ' + x.info]) tr.append(el('td', '', String(v))); t.append(tr); }
    out.append(t, el('h3', '', 'Findings and fixes'));
    for (const i of j.findings) {
      const d = el('div', 'iss ' + i.severity);
      d.append(el('strong', '', i.severity.toUpperCase() + (i.tool ? ' · ' + i.tool : ' · all tools') + (i.path ? ' · ' + i.path : '') + (i.count > 1 ? ' (×' + i.count + ')' : '')), el('div', '', i.message), el('div', 'fix', 'Fix: ' + i.fix));
      out.append(d);
    }
    if (j.findingsOmitted) out.append(el('p', 'small', j.findingsOmitted + ' more finding(s) not shown.'));
  } catch { st.textContent = 'Request failed.'; }
});
</script></body></html>`;

const shell = (title, path, inner) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ToolGrade</title><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${CANONICAL}${path}">
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;color:#111;background:#f8fafc}.wrap{max-width:760px;margin:0 auto;padding:16px}</style></head><body>
<main class="wrap"><h1>${title}</h1>${inner}
<p><a href="/">Back to ToolGrade</a> · v${VERSION} · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p></main></body></html>`;

export const termsPage = (L = { freeMonthly: 100 }) => shell('Terms of use', 'terms', `
<p>ToolGrade is a free tool provided as is, without warranty of any kind. Scores and findings are automated, opinionated checks of the JSON you paste against the MCP tools specification and common client limits. A high grade does not guarantee that any particular AI client will use your tools well, and token counts are estimates.</p>
<p>Fair use: anonymous use is rate-limited (per minute per IP and a shared daily pool); free API keys have a monthly quota of about ${L.freeMonthly} grades. Keys are personal, may be revoked for abuse, and expire if unused for about 13 months. There is no paid tier. Don't attempt to bypass limits or overload the service. Access may be limited or withdrawn at any time.</p>
<p>${esc(FOR_AGENTS)} ${esc(NOT_AFFILIATED)}</p>
<p>Privacy: nothing you paste is stored. See <a href="/privacy">Privacy</a>.</p>
<p>These terms may change; the current version is always at this page.</p>`);

export const privacyPage = () => shell('Privacy', 'privacy', `
<p><strong>Nothing you paste is stored.</strong> ${esc(NOTHING_STORED)}</p>
<p>That includes tool names, descriptions and schemas: they appear only in the response sent back to you.</p>
<p>What is kept:</p><ul><li>Daily visitor count: a one-way hash of your network address combined with a secret salt and the date, used only to count unique daily visitors. The address itself is never stored, the hash is not linked to anything you submit, and it expires after 9 days.</li><li>Rate limits: per-minute limits are counted by Cloudflare's rate limiter, keyed by network address (or API key), and are not stored by ToolGrade.</li><li>A running count of anonymous grades per UTC day.</li><li>Free API keys: only a SHA-256 hash of each key, its creation date and a monthly usage count. No email, no name, no tool data.</li></ul><p>No cookies, no trackers, no analytics scripts.</p>
<p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`);
