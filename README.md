# ToolGrade

Grade MCP tool definitions for agent-readiness: score, A-F grade, fixes, est. token cost.

## Live service

- Web app and API: https://toolgrade.mike-tusa.workers.dev/
- Plans: Free, no paid plan (https://toolgrade.mike-tusa.workers.dev/)
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

ToolGrade is a remote MCP server (Streamable HTTP) at `https://toolgrade.mike-tusa.workers.dev/mcp`. Tools: `grade_tools`.

Cursor and Windsurf accept this config:

```json
{
  "mcpServers": {
    "toolgrade": {
      "type": "http",
      "url": "https://toolgrade.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Cline (MCP Servers > Remote Servers, or `cline_mcp_settings.json`) needs `"type": "streamableHttp"`:

```json
{
  "mcpServers": {
    "toolgrade": {
      "type": "streamableHttp",
      "url": "https://toolgrade.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://toolgrade.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://toolgrade.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 22+ and a Cloudflare account.

```bash
npm install
npx wrangler@4 dev      # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler@4 deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

Optional Worker secrets (leave unset if you do not need them): `GLAMA_CLAIM` (your glama.ai connector claim token, served at `/.well-known/glama.json`).

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
