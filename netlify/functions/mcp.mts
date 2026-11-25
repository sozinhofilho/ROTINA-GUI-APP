// Endpoint público do conector MCP: https://<site>.netlify.app/mcp
// (config.path faz a Netlify servir esta Function direto em /mcp, sem redirect extra.)
import { makeExportUrl } from '../lib/export-link.ts'
import { createMcpHandler } from '../lib/mcp.ts'
import { env } from '../lib/server.ts'
import { supabaseStore } from '../lib/store.ts'

export const config = { path: ['/mcp', '/mcp/*'] }

export default createMcpHandler({
  store: supabaseStore,
  token: () => env('MCP_TOKEN'),
  allowPathToken: () => env('MCP_ALLOW_PATH_TOKEN') === 'true',
  baseUrl: (req) => env('URL') ?? new URL(req.url).origin,
  exportUrl: makeExportUrl,
})
