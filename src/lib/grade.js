/**
 * ToolGrade engine: grades MCP tool definitions (a tools/list response, its result, or a bare tool array) for
 * agent-readiness. Pure parsing: no network, no storage, no eval. Every loop is bounded (MAX_TOOLS, MAX_DEPTH,
 * MAX_NODES), so CPU per request stays small even for a 256 KB body.
 */
export const VERSION = '0.1.3';
export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_TOOLS = 200;
export const MAX_DEPTH = 8;
export const MAX_NODES = 6000; // schema nodes visited per request (all tools together)
export const MAX_FINDINGS = 400;
export const MAX_REQUIRED = 1000; // entries of a `required` array checked against properties
export const CHARS_PER_TOKEN = 4;
export const TOKEN_NOTE = 'Estimate only: compact-JSON characters divided by 4. Real token counts vary by model, tokenizer and how each client serializes tool definitions.';
const PENALTY = { critical: 20, warning: 5, info: 1 };
const GLOBAL_PENALTY = { critical: 10, warning: 3, info: 1 };
const SEV_ORDER = { critical: 0, warning: 1, info: 2 };

export class GradeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.httpStatus = status; }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Display-safe: strip control / bidi / zero-width characters, then clip. Input is untrusted.
const HIDDEN_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const HIDDEN_RE_G = new RegExp(HIDDEN_RE.source, 'gu');
export const clip = (s, n = 80) => { const t = String(s).replace(HIDDEN_RE_G, ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const gradeFor = (score) => (score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F');
export const estimateTokens = (v) => { let s; try { s = JSON.stringify(v); } catch { s = ''; } return Math.ceil((s ? s.length : 0) / CHARS_PER_TOKEN); };

/** Parse body text to JSON or throw GradeError. */
export function parseInput(text) {
  if (typeof text !== 'string' || !text.trim()) throw new GradeError('invalid_input', 'Send a tools/list response, its result ({"tools": [...]}) or a JSON array of tool definitions.');
  try { return JSON.parse(text); } catch { throw new GradeError('invalid_json', 'Body is not valid JSON. Paste the raw JSON output of an MCP tools/list call.'); }
}

/** Find the tool array in a tools/list response, result object, batch of responses, or bare array. */
export function extractTools(data) {
  let tools; let source;
  const fromRpc = (o) => {
    if (isObj(o.error)) throw new GradeError('invalid_input', 'That JSON-RPC message is an error response, not a tools list.');
    if (isObj(o.result) && Array.isArray(o.result.tools)) return o.result.tools;
    return null;
  };
  if (Array.isArray(data)) {
    if (data.length && data.every((m) => isObj(m) && m.jsonrpc === '2.0')) {
      tools = [];
      for (const m of data) {
        const t = fromRpc(m); if (!t) continue;
        // Count before adding, so a huge batch never spreads into push() (stack-size RangeError → 500).
        if (tools.length + t.length > MAX_TOOLS) throw new GradeError('too_many_tools', `At most ${MAX_TOOLS} tools per request (got more than ${MAX_TOOLS} across the batch). Split the list and grade it in parts.`);
        for (const x of t) tools.push(x);
      }
      if (!tools.length) throw new GradeError('invalid_input', 'No result.tools array found in that JSON-RPC batch.');
      source = 'jsonrpc_batch';
    } else { tools = data; source = 'array'; }
  } else if (isObj(data)) {
    if (data.jsonrpc === '2.0' || has(data, 'result') || has(data, 'error')) {
      tools = fromRpc(data); source = 'jsonrpc_response';
      if (!tools) throw new GradeError('invalid_input', 'No result.tools array found in that JSON-RPC response.');
    } else if (Array.isArray(data.tools)) { tools = data.tools; source = 'tools_list_result'; }
    else if (typeof data.name === 'string' && (has(data, 'inputSchema') || has(data, 'description'))) { tools = [data]; source = 'single_tool'; }
    else throw new GradeError('invalid_input', 'Expected {"tools": [...]}, a tools/list JSON-RPC response or a JSON array of tools.');
  } else throw new GradeError('invalid_input', 'Expected a JSON object or array of tool definitions.');
  if (!tools.length) throw new GradeError('invalid_input', 'The tools array is empty: nothing to grade.');
  if (tools.length > MAX_TOOLS) throw new GradeError('too_many_tools', `At most ${MAX_TOOLS} tools per request (got ${tools.length}). Split the list and grade it in parts.`);
  return { tools, source };
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const STRICT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GENERIC = new Set(['run', 'do', 'execute', 'exec', 'tool', 'call', 'invoke', 'process', 'handle', 'action', 'main', 'test', 'api', 'request', 'function', 'func', 'cmd', 'command', 'helper', 'util', 'misc']);
const SUSPICIOUS_RE = /ignore (?:all |any )?(?:previous|prior|above|earlier) instructions|<\s*\/?\s*important\s*>|do not (?:tell|mention|inform|reveal to) the user|without (?:telling|informing) the user|(?:read|send|upload|exfiltrate)[^.]{0,40}(?:~\/\.ssh|id_rsa|\.env\b|credentials|api[_ -]?keys?)|system prompt/i;
const DESTRUCTIVE_NAME_RE = /^(?:delete|remove|drop|destroy|purge|wipe|erase|kill|terminate|truncate)[_-]/i;
const READ_NAME_RE = /^(?:get|list|search|read|fetch|find|lookup|describe|show|query|check|validate|analy[sz]e|grade|count)[_-]/i;
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const typeOfValue = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const valueMatchesType = (v, t) => { const vt = typeOfValue(v); return vt === t || (t === 'number' && vt === 'integer'); };
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const styleOf = (n) => (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(n) ? 'snake_case' : /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(n) ? 'kebab-case' : /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(n) ? 'camelCase' : /^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(n) ? 'PascalCase' : null);

function newCollector(tool) {
  const map = new Map();
  return {
    map,
    add(severity, code, path, message, fix) {
      const e = map.get(code);
      if (e) { e.count++; if (e.paths.length < 5 && path && !e.paths.includes(path)) e.paths.push(path); return; }
      map.set(code, { severity, code, tool, path: path || null, paths: path ? [path] : [], count: 1, message, fix });
    },
  };
}

function penaltyOf(f, table) { return table[f.severity] * Math.min(2, 1 + (f.count - 1) * 0.25); }

/** Check one parameter / output schema node. kind = 'input' | 'output'. */
function walk(s, path, depth, ctx, { named, kind }) {
  const { c } = ctx;
  if (++ctx.nodes > MAX_NODES) { ctx.truncated = true; return; }
  if (depth > MAX_DEPTH) { c.add('info', 'schema_too_deep', path, `Schema nesting is deeper than ${MAX_DEPTH} levels; ToolGrade stopped checking below this point.`, 'Flatten deeply nested objects. Models fill shallow, flat arguments far more reliably.'); return; }
  if (s === true || (isObj(s) && Object.keys(s).length === 0)) {
    c.add('warning', kind === 'input' ? 'param_untyped' : 'output_untyped', path, 'Schema accepts any value (no type).', 'Add a type, e.g. "type": "string", plus a description and limits.');
    if (kind === 'input' && named) c.add('warning', 'param_description_missing', path, 'Parameter has no description.', 'Describe what the value means, its format and an example, e.g. "City name, e.g. \\"Denver\\"".');
    return;
  }
  if (!isObj(s)) { c.add('critical', 'schema_invalid', path, 'Schema is not a JSON object.', 'Each property must be a JSON Schema object such as {"type": "string", "description": "..."}.'); return; }

  const types = Array.isArray(s.type) ? s.type : s.type === undefined ? [] : [s.type];
  const comp = ['anyOf', 'oneOf', 'allOf'].filter((k) => Array.isArray(s[k]));
  const typed = types.length || Array.isArray(s.enum) || has(s, 'const') || typeof s.$ref === 'string' || comp.length;
  if (types.some((t) => typeof t !== 'string' || !JSON_TYPES.has(t))) c.add('critical', 'type_invalid', path, 'Unknown JSON Schema type.', 'Use one of string, number, integer, boolean, object, array, null.');
  if (!typed) c.add('warning', kind === 'input' ? 'param_untyped' : 'output_untyped', path, 'No type declared.', 'Add "type" (e.g. "string", "integer", "boolean", "array", "object") so the model sends the right kind of value.');
  if (types.length > 1 && types.includes('null')) c.add('info', 'nullable_type_union', path, 'Type array with "null" (e.g. ["string","null"]).', kind === 'input' ? 'Prefer a single type and leave the property out of "required"; some strict function-calling modes reject type arrays.' : 'Omit the field when it has no value instead of declaring ["type","null"]; some clients validate structuredContent strictly.');
  if (typeof s.$ref === 'string') c.add('info', 'ref_used', path, '$ref used.', 'Inline the referenced schema; not every MCP client resolves $ref / $defs.');
  if (comp.length && kind === 'input') c.add('info', 'composite_schema', path, `${comp.join('/')} used.`, 'Some clients flatten or reject anyOf/oneOf/allOf. Where possible use one type with an enum, or split into separate tools.');

  if (kind === 'input' && named) {
    const d = s.description;
    if (typeof d !== 'string' || !d.trim()) c.add('warning', 'param_description_missing', path, 'Parameter has no description.', 'Describe what the value means, its format and an example, e.g. "City name, e.g. \\"Denver\\"".');
    else if (d.trim().length < 8) c.add('info', 'param_description_short', path, 'Parameter description is very short.', 'Say what the value is, its format or units, and give an example.');
  }
  for (const k of ['description', 'title']) if (typeof s[k] === 'string' && HIDDEN_RE.test(s[k])) c.add('warning', 'hidden_characters', path, 'Invisible or bidirectional Unicode characters in schema text.', 'Remove zero-width, bidi-override and tag characters; they can hide instructions from human reviewers.');
  if (typeof s.description === 'string' && SUSPICIOUS_RE.test(s.description)) c.add('warning', 'suspicious_instructions', path, 'Schema description contains instruction-like text often seen in tool-poisoning attacks.', 'Keep descriptions factual. Never address the model with hidden directives or ask it to read secrets.');

  // enum
  if (has(s, 'enum')) {
    if (!Array.isArray(s.enum) || !s.enum.length) c.add('critical', 'enum_invalid', path, 'enum must be a non-empty array.', 'List the allowed values, e.g. "enum": ["asc", "desc"], or remove enum.');
    else {
      const seen = new Set(); let dup = false;
      for (const v of s.enum.slice(0, 1000)) { const k = JSON.stringify(v); if (seen.has(k)) dup = true; seen.add(k); }
      if (dup) c.add('warning', 'enum_duplicates', path, 'enum has duplicate values.', 'Remove the repeated values.');
      if (types.length && s.enum.some((v) => !types.some((t) => valueMatchesType(v, t)))) c.add('warning', 'enum_type_mismatch', path, `enum values don't match the declared type (${types.join('/')}).`, 'Make every enum value the declared type, or fix "type".');
      if (s.enum.length === 1) c.add('info', 'enum_single_value', path, 'enum has a single value.', 'Use "const" or drop the parameter; a one-value choice wastes tokens.');
      if (s.enum.length > 50) c.add('info', 'enum_large', path, `enum has ${s.enum.length} values.`, 'Large enums cost tokens on every request. Consider a free string with a pattern or a lookup tool.');
      if (has(s, 'default') && Array.isArray(s.enum) && !s.enum.some((v) => JSON.stringify(v) === JSON.stringify(s.default))) c.add('warning', 'default_not_in_enum', path, 'default is not one of the enum values.', 'Set default to an allowed value.');
      if (kind === 'input' && s.enum.some((v) => typeof v === 'string' && !v.trim())) c.add('info', 'enum_empty_string', path, 'enum contains an empty string.', 'Leave the property optional instead of allowing "".');
    }
  }
  if (has(s, 'default') && types.length && !types.some((t) => valueMatchesType(s.default, t))) c.add('warning', 'default_type_mismatch', path, 'default does not match the declared type.', 'Use a default of the declared type.');

  const bounded = Array.isArray(s.enum) || has(s, 'const');
  if (types.includes('string') && kind === 'input') {
    if (s.maxLength === undefined && !bounded) c.add('warning', 'string_no_max_length', path, 'String without maxLength.', 'Add "maxLength" (e.g. 256 for names, 2048 for URLs, a few thousand for free text) so oversized inputs fail fast and cheaply.');
    if (s.maxLength !== undefined && !nonNegInt(s.maxLength)) c.add('critical', 'constraint_invalid', path, 'maxLength must be a non-negative integer.', 'Use an integer such as 256.');
    if (s.minLength !== undefined && !nonNegInt(s.minLength)) c.add('critical', 'constraint_invalid', path, 'minLength must be a non-negative integer.', 'Use an integer such as 1.');
    if (nonNegInt(s.minLength) && nonNegInt(s.maxLength) && s.minLength > s.maxLength) c.add('critical', 'constraint_conflict', path, 'minLength is greater than maxLength.', 'Fix the bounds; no value can satisfy them.');
    if (typeof s.pattern === 'string') { try { new RegExp(s.pattern, 'u'); } catch { c.add('critical', 'pattern_invalid', path, 'pattern is not a valid regular expression.', 'Fix the regex (JSON Schema patterns use ECMA-262 syntax).'); } }
  }
  if ((types.includes('number') || types.includes('integer')) && kind === 'input') {
    const lo = s.minimum ?? s.exclusiveMinimum, hi = s.maximum ?? s.exclusiveMaximum;
    if (lo === undefined && hi === undefined && !bounded) c.add('info', 'number_unbounded', path, 'Number without minimum/maximum.', 'Add "minimum"/"maximum" (e.g. a limit of 1–100) so the model stays in range.');
    if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) c.add('critical', 'constraint_conflict', path, 'minimum is greater than maximum.', 'Fix the bounds; no value can satisfy them.');
  }
  if (types.includes('array')) {
    if (s.items === undefined && s.prefixItems === undefined) c.add('warning', 'array_items_missing', path, 'Array without "items".', 'Declare the item schema, e.g. "items": {"type": "string", "maxLength": 200}.');
    else if (s.items !== undefined) walk(s.items, `${path}.items`, depth + 1, ctx, { named: false, kind });
    if (kind === 'input' && s.maxItems === undefined) c.add('info', 'array_no_max_items', path, 'Array without maxItems.', 'Add "maxItems" so a model cannot send thousands of entries.');
    if (nonNegInt(s.minItems) && nonNegInt(s.maxItems) && s.minItems > s.maxItems) c.add('critical', 'constraint_conflict', path, 'minItems is greater than maxItems.', 'Fix the bounds.');
  }
  if (types.includes('object') || isObj(s.properties)) objectChecks(s, path, depth, ctx, { root: false, kind });
  for (const k of comp) s[k].slice(0, 20).forEach((sub, i) => walk(sub, `${path}.${k}[${i}]`, depth + 1, ctx, { named: false, kind }));
}

function objectChecks(s, path, depth, ctx, { root, kind }) {
  const { c } = ctx;
  const props = s.properties;
  if (props !== undefined && !isObj(props)) { c.add('critical', 'properties_invalid', `${path}.properties`, '"properties" must be an object.', 'Use "properties": {"name": {"type": "string"}}.'); return; }
  const names = props ? Object.keys(props) : [];
  if (kind === 'input') {
    if (s.additionalProperties !== false && (root || names.length)) {
      c.add(root ? 'warning' : 'info', root ? 'additional_properties_open' : 'nested_additional_properties_open', path, root ? 'inputSchema does not set additionalProperties: false.' : 'Nested object does not set additionalProperties: false.', 'Add "additionalProperties": false so made-up or misspelled arguments are rejected instead of silently ignored.');
    }
    if (names.length && s.required === undefined) c.add(root ? 'warning' : 'info', 'required_missing', path, 'No "required" list.', 'List mandatory parameters, e.g. "required": ["query"]. If all are optional, write "required": [] to make that explicit.');
  }
  if (s.required !== undefined) {
    if (!Array.isArray(s.required) || s.required.some((r) => typeof r !== 'string')) c.add('critical', 'required_invalid', `${path}.required`, '"required" must be an array of property names.', 'Use "required": ["param_a", "param_b"].');
    else {
      // Set lookup (was names.includes → O(required × properties)) and a cap on how many entries are checked.
      const nameSet = new Set(names);
      if (s.required.length > MAX_REQUIRED) c.add('warning', 'required_too_long', `${path}.required`, `"required" has ${s.required.length} entries; only the first ${MAX_REQUIRED} were checked.`, 'Keep the required list to the parameters a caller must actually send.');
      const req = s.required.length > MAX_REQUIRED ? s.required.slice(0, MAX_REQUIRED) : s.required;
      const unknown = req.filter((r) => !nameSet.has(r));
      if (unknown.length) c.add('critical', kind === 'input' ? 'required_unknown_property' : 'output_required_unknown', `${path}.required`, `"required" lists properties that are not defined: ${clip(unknown.slice(0, 5).join(', '), 120)}.`, 'Define each required property under "properties", or remove it from "required".');
      if (new Set(req).size !== req.length) c.add('info', 'required_duplicates', `${path}.required`, '"required" repeats a name.', 'List each property once.');
    }
  }
  if (root && kind === 'input' && names.length > 20) c.add('info', 'many_parameters', path, `${names.length} parameters.`, 'Tools with many parameters are harder for models to fill correctly. Split into focused tools or group options into an object.');
  for (const n of names.slice(0, 500)) {
    const p = `${path}.properties.${clip(n, 40)}`;
    if (kind === 'input' && !/^[A-Za-z0-9_.-]{1,64}$/.test(n)) c.add('warning', 'param_name_invalid', p, 'Parameter name has unusual characters or is over 64 characters.', 'Use letters, digits and _ (e.g. "max_results"); some function-calling APIs reject other characters.');
    walk(props[n], p, depth + 1, ctx, { named: true, kind });
  }
}

function gradeTool(t, index, ctx) {
  const label = isObj(t) && typeof t.name === 'string' && t.name ? clip(t.name, 80) : `#${index}`;
  const c = newCollector(label);
  ctx.c = c;
  if (!isObj(t)) { c.add('critical', 'tool_not_object', null, 'Tool entry is not a JSON object.', 'Each tool must be an object with name, description and inputSchema.'); return { c, label, tokens: estimateTokens(t) }; }
  const name = t.name;
  if (typeof name !== 'string' || !name) c.add('critical', 'name_missing', 'name', 'Tool has no name.', 'Add a unique name such as "search_issues" (letters, digits, _ and -).');
  else {
    if (name.length > 128) c.add('critical', 'name_too_long', 'name', `Name is ${name.length} characters (MCP spec maximum is 128).`, 'Shorten it; 64 or fewer works with every major client.');
    else if (name.length > 64) c.add('warning', 'name_over_64', 'name', `Name is ${name.length} characters.`, 'Keep names to 64 characters or fewer; several function-calling APIs reject longer names.');
    if (!NAME_RE.test(name)) c.add('critical', 'name_invalid_chars', 'name', 'Name has characters outside A-Z, a-z, 0-9, _, - and . (for example spaces).', `Rename to something like "${clip(name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'my_tool', 64)}".`);
    else if (!STRICT_NAME_RE.test(name) && name.includes('.')) c.add('info', 'name_has_dot', 'name', 'Name contains a dot.', 'Dots are allowed by MCP but some clients map tools to APIs that only accept ^[a-zA-Z0-9_-]{1,64}$. Prefer _ or -.');
    if (GENERIC.has(name.toLowerCase())) c.add('warning', 'name_generic', 'name', `"${clip(name, 40)}" is too generic to pick from a list of tools.`, 'Use verb_object naming that says what it does, e.g. "search_tickets" or "create_invoice".');
    if (HIDDEN_RE.test(name)) c.add('critical', 'hidden_characters', 'name', 'Name contains invisible or control characters.', 'Remove them; they make the tool impossible to call reliably.');
  }
  const d = t.description;
  const titleStr = typeof t.title === 'string' ? t.title : isObj(t.annotations) && typeof t.annotations.title === 'string' ? t.annotations.title : '';
  if (typeof d !== 'string' || !d.trim()) c.add('critical', 'description_missing', 'description', 'Tool has no description.', 'Write 1–3 sentences: what it does, when to use it (and when not), what it returns, and side effects. Models choose tools mostly from this text.');
  else {
    const dt = d.trim();
    if (dt.length < 20) c.add('warning', 'description_too_short', 'description', `Description is only ${dt.length} characters.`, 'Expand to 1–3 sentences: purpose, when to use it, what it returns, and any side effects or limits.');
    else if (dt.length < 60 && dt.split(/\s+/).length < 8) c.add('info', 'description_brief', 'description', 'Description is brief.', 'Add when to use the tool and what it returns.');
    if ((typeof name === 'string' && norm(dt) === norm(name)) || (titleStr && norm(dt) === norm(titleStr))) c.add('warning', 'description_restates_name', 'description', 'Description only repeats the name or title.', 'Describe behavior, inputs, outputs and side effects instead of restating the name.');
    if (dt.length > 2000) c.add('warning', 'description_too_long', 'description', `Description is ${dt.length} characters (about ${Math.ceil(dt.length / CHARS_PER_TOKEN)} tokens, estimated) and is sent with every request.`, 'Trim to the essentials (under ~1,000 characters); move long examples to docs or a resource.');
    else if (dt.length > 1000) c.add('info', 'description_long', 'description', `Description is ${dt.length} characters.`, 'Consider trimming; every tool description is sent to the model on each request.');
    if (HIDDEN_RE.test(d)) c.add('warning', 'hidden_characters', 'description', 'Invisible or bidirectional Unicode characters in the description.', 'Remove zero-width, bidi-override and tag characters; they can hide instructions from human reviewers.');
    if (SUSPICIOUS_RE.test(d)) c.add('warning', 'suspicious_instructions', 'description', 'Description contains instruction-like text often seen in tool-poisoning attacks (e.g. "ignore previous instructions", <IMPORTANT> blocks, asking for secrets).', 'Keep descriptions factual. Never address the model with hidden directives, and never ask it to read or send credentials.');
  }
  if (!titleStr) c.add('info', 'title_missing', 'title', 'No human-readable title.', 'Add "title" (e.g. "Search tickets"); clients show it in tool pickers and approval prompts.');

  const s = t.inputSchema;
  if (s === undefined) c.add('critical', 'input_schema_missing', 'inputSchema', 'No inputSchema (required by the MCP spec).', 'For a tool without arguments use {"type": "object", "properties": {}, "additionalProperties": false}.');
  else if (!isObj(s)) c.add('critical', 'input_schema_invalid', 'inputSchema', 'inputSchema is not a JSON object.', 'Use a JSON Schema object with "type": "object".');
  else {
    if (s.type !== 'object') c.add('critical', 'input_schema_not_object', 'inputSchema.type', 'inputSchema.type must be "object".', 'Set "type": "object" and put arguments under "properties".');
    ctx.depthStart = 0;
    objectChecks(s, 'inputSchema', 0, ctx, { root: true, kind: 'input' });
  }

  const a = t.annotations;
  if (a === undefined) c.add('warning', 'annotations_missing', 'annotations', 'No annotations.', 'Add "annotations": {"readOnlyHint": true|false, "destructiveHint": …, "idempotentHint": …, "openWorldHint": …}. Clients use them to auto-approve safe tools and warn before destructive ones.');
  else if (!isObj(a)) c.add('critical', 'annotations_invalid', 'annotations', 'annotations is not an object.', 'Use an object of boolean hints.');
  else {
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) if (a[k] !== undefined && typeof a[k] !== 'boolean') c.add('critical', 'annotation_not_boolean', `annotations.${k}`, `${k} must be true or false.`, `Set "${k}" to a boolean.`);
    if (a.readOnlyHint === undefined) c.add('warning', 'read_only_hint_missing', 'annotations.readOnlyHint', 'readOnlyHint is not set (clients assume the tool may modify things).', 'Set "readOnlyHint": true for tools that only read; false otherwise.');
    if (a.readOnlyHint !== true && a.destructiveHint === undefined) c.add('warning', 'destructive_hint_missing', 'annotations.destructiveHint', 'destructiveHint is not set on a tool that may write (the spec default is true, i.e. destructive).', 'Set "destructiveHint": false if the tool only adds or updates without deleting or overwriting; true if it can destroy data.');
    if (a.readOnlyHint === true && a.destructiveHint === true) c.add('critical', 'annotations_contradictory', 'annotations', 'readOnlyHint and destructiveHint are both true.', 'A read-only tool cannot be destructive: set destructiveHint to false (or readOnlyHint to false).');
    if (a.readOnlyHint !== true && a.idempotentHint === undefined) c.add('info', 'idempotent_hint_missing', 'annotations.idempotentHint', 'idempotentHint is not set.', 'Set "idempotentHint": true if calling twice with the same arguments has no extra effect; clients can then retry safely.');
    if (a.openWorldHint === undefined) c.add('info', 'open_world_hint_missing', 'annotations.openWorldHint', 'openWorldHint is not set (default true).', 'Set "openWorldHint": false if the tool only touches a closed system (your database, local files); true if it reaches the open internet.');
    if (typeof name === 'string' && DESTRUCTIVE_NAME_RE.test(name) && a.readOnlyHint === true) c.add('warning', 'annotation_name_mismatch', 'annotations.readOnlyHint', 'Name suggests deletion but readOnlyHint is true.', 'Check the hint: a delete/remove tool should be readOnlyHint false, destructiveHint true.');
  }
  if (typeof name === 'string' && READ_NAME_RE.test(name) && (!isObj(a) || a.readOnlyHint === undefined)) c.add('info', 'consider_read_only', 'annotations.readOnlyHint', 'Name suggests a read-only tool.', 'If it only reads, set "readOnlyHint": true so clients can run it without a confirmation prompt.');

  const o = t.outputSchema;
  if (o === undefined) c.add('info', 'output_schema_missing', 'outputSchema', 'No outputSchema.', 'Add an outputSchema ("type": "object") and return matching structuredContent so agents can use results without parsing text.');
  else if (!isObj(o) || o.type !== 'object') c.add('critical', 'output_schema_not_object', 'outputSchema', 'outputSchema must be a JSON Schema with "type": "object".', 'Wrap results in an object, e.g. {"type": "object", "properties": {"items": {"type": "array", ...}}}.');
  else {
    if (!isObj(o.properties) || !Object.keys(o.properties).length) c.add('info', 'output_schema_empty', 'outputSchema', 'outputSchema declares no properties.', 'List the fields you return so clients can validate and use structuredContent.');
    objectChecks(o, 'outputSchema', 0, ctx, { root: true, kind: 'output' });
  }
  if (has(t, 'execution') && !isObj(t.execution)) c.add('critical', 'execution_invalid', 'execution', '"execution" must be an object.', 'Remove it or use the shape from the MCP spec.');
  const tokens = estimateTokens(t);
  if (tokens > 1500) c.add('warning', 'tool_too_large', null, `This definition is about ${tokens} tokens (estimated).`, 'Trim descriptions and large enums; very large tool definitions crowd the model\'s context on every request.');
  return { c, label, tokens };
}

/** Grade an already-extracted tools array. Returns the full report body. */
export function gradeTools(tools, { source = 'array' } = {}) {
  const ctx = { nodes: 0, truncated: false, c: null };
  const perTool = []; const all = [];
  tools.forEach((t, i) => {
    const r = gradeTool(t, i, ctx);
    const fs = [...r.c.map.values()];
    const score = Math.max(0, Math.round(100 - fs.reduce((sum, f) => sum + penaltyOf(f, PENALTY), 0)));
    const cnt = { critical: 0, warning: 0, info: 0 }; for (const f of fs) cnt[f.severity]++;
    perTool.push({ index: i, name: r.label, score, grade: gradeFor(score), estimatedTokens: r.tokens, ...cnt });
    fs.forEach((f) => all.push({ ...f, index: i }));
  });

  const g = newCollector(null);
  // duplicates and naming across tools
  const byName = new Map(); const byLower = new Map();
  tools.forEach((t, i) => { if (isObj(t) && typeof t.name === 'string' && t.name) { (byName.get(t.name) || byName.set(t.name, []).get(t.name)).push(i); (byLower.get(t.name.toLowerCase()) || byLower.set(t.name.toLowerCase(), []).get(t.name.toLowerCase())).push(t.name); } });
  for (const [n, idx] of byName) if (idx.length > 1) g.add('critical', 'duplicate_name', `tools[${idx.join(',')}]`, `"${clip(n, 60)}" is used by ${idx.length} tools.`, 'Tool names must be unique within a server; clients will call the wrong one or drop duplicates. Rename or merge them.');
  for (const [, ns] of byLower) if (new Set(ns).size > 1) g.add('warning', 'name_case_collision', null, `Names differ only by case: ${clip([...new Set(ns)].join(', '), 120)}.`, 'Rename so names differ by more than letter case; some clients treat them as the same tool.');
  const styles = new Set(); for (const n of byName.keys()) { const st = styleOf(n); if (st) styles.add(st); }
  if (styles.size > 1) g.add('info', 'mixed_naming', null, `Mixed naming styles: ${[...styles].join(', ')}.`, 'Pick one convention (snake_case is the most common for MCP tools) and use it for every tool.');
  const total = perTool.reduce((s, t) => s + t.estimatedTokens, 0);
  if (tools.length > 40) g.add('warning', 'many_tools', null, `${tools.length} tools in one server.`, 'Many clients degrade or limit large tool sets (about 40 is a common practical ceiling). Split into focused servers or toolsets.');
  if (total > 10000) g.add('warning', 'definitions_large', null, `All definitions together are about ${total} tokens (estimated).`, 'This is sent with every request. Trim descriptions, enums and unused tools.');
  else if (total > 5000) g.add('info', 'definitions_sizeable', null, `All definitions together are about ${total} tokens (estimated).`, 'Keep an eye on size; trimming descriptions and enums reduces cost on every request.');
  if (ctx.truncated) g.add('info', 'schema_truncated', null, `Schemas are very large; ToolGrade stopped after ${MAX_NODES} schema nodes, so some deep checks were skipped.`, 'Large, deep schemas are hard for models too. Simplify them.');
  const gf = [...g.map.values()];

  const mean = perTool.length ? perTool.reduce((s, t) => s + t.score, 0) / perTool.length : 0;
  const score = Math.max(0, Math.min(100, Math.round(mean - gf.reduce((s, f) => s + penaltyOf(f, GLOBAL_PENALTY), 0))));
  const findings = [...gf.map((f) => ({ ...f, index: null })), ...all]
    .sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (a.index ?? -1) - (b.index ?? -1));
  const counts = { critical: 0, warning: 0, info: 0 }; for (const f of findings) counts[f.severity]++;
  const shown = findings.slice(0, MAX_FINDINGS).map((f) => ({ severity: f.severity, code: f.code, tool: f.tool, ...(f.path ? { path: f.path } : {}), ...(f.count > 1 ? { count: f.count, paths: f.paths } : {}), message: f.message, fix: f.fix }));
  const largest = perTool.reduce((m, t) => (t.estimatedTokens > m.tokens ? { name: t.name, tokens: t.estimatedTokens } : m), { name: null, tokens: 0 });
  const grade = gradeFor(score);
  return {
    score, grade,
    summary: { tools: tools.length, ...counts, source, verdictMeaning: verdictMeaning(grade, counts) },
    tokenEstimate: { estimated: true, totalTokens: total, averagePerTool: perTool.length ? Math.round(total / perTool.length) : 0, largestTool: largest, method: 'chars/4 of compact JSON', note: TOKEN_NOTE },
    tools: perTool,
    findings: shown,
    ...(findings.length > shown.length ? { findingsOmitted: findings.length - shown.length } : {}),
    meta: { version: VERSION, stored: false, networkLookups: false, maxTools: MAX_TOOLS },
  };
}

function verdictMeaning(grade, n) {
  const base = { A: 'Agent-ready: clear names, descriptions, typed and bounded schemas, and annotations.', B: 'Good: a few gaps that can make models misuse or skip tools.', C: 'Fair: several gaps; models will guess at arguments or pick the wrong tool sometimes.', D: 'Weak: many missing descriptions, types or limits.', F: 'Not agent-ready: fix the critical findings first.' }[grade];
  return `${base} ${n.critical} critical, ${n.warning} warning, ${n.info} info.`;
}

/** Convenience: JSON text or value → report. Throws GradeError on bad input. */
export function grade(input) {
  const data = typeof input === 'string' ? parseInput(input) : input;
  const { tools, source } = extractTools(data);
  return gradeTools(tools, { source });
}
