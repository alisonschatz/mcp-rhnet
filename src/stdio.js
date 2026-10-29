import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SPEC_AUTO_UPDATE_MINUTES, SPECS_DIR } from './config.js';
import { buildMcpServer } from './mcp.js';
import { listApiIds } from './specs.js';
import { startAutoUpdate } from './updater.js';

// Em stdio o stdout é o canal do protocolo: logs vão sempre para stderr.
const server = buildMcpServer();
await server.connect(new StdioServerTransport());
console.error(`[mcp] stdio pronto (specs: ${SPECS_DIR}, ${listApiIds().length} API(s))`);
startAutoUpdate(SPEC_AUTO_UPDATE_MINUTES, console.error);
