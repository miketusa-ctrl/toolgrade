// Demo inputs for the homepage and tests. Fictional tools; no real server.
export const SAMPLE_NEEDS_WORK = {
  jsonrpc: '2.0', id: 1,
  result: {
    tools: [
      { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'delete file', description: 'Deletes a file from the workspace.', inputSchema: { type: 'object', properties: { path: {} }, required: ['path', 'force'] }, annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: 'get_weather', description: 'Get the current weather for a city. Returns temperature in Celsius, conditions and wind speed.', inputSchema: { type: 'object', properties: { city: { type: 'string', description: 'City name, e.g. "Denver"' }, units: { type: 'string', enum: ['metric', 'imperial', 'metric'], default: 'kelvin' } }, required: ['city'] }, outputSchema: { type: 'array' } },
      { name: 'search', description: 'Search again', inputSchema: { type: 'string' } },
    ],
  },
};
export const SAMPLE_GOOD = [{
  name: 'search_docs',
  title: 'Search documentation',
  description: 'Full-text search over the product documentation. Use it to answer how-to questions; returns up to `limit` matching pages with title, URL and a short snippet. Read-only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Search words, e.g. "rotate api key"' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5, description: 'Maximum number of results (1-20).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' }, snippet: { type: 'string' } }, required: ['title', 'url'] } } }, required: ['results'] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
