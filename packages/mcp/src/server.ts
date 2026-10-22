import { resultContent } from '@brickloop/ai';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { BridgeClient, type BridgeClientOptions } from './bridge-client.js';
import { BridgeError } from './protocol.js';
import { createMcpTools, failure, MCP_INSTRUCTIONS } from './tools.js';

export type McpServerOptions = Omit<BridgeClientOptions, 'client'>;
export function createMcpServer(options: McpServerOptions = {}): Server {
  // The SDK's low-level Server preserves the AI package's draft-7 JSON Schema
  // byte-for-byte in tools/list instead of converting it a second time.
  const server = new Server(
    { name: 'brickloop-mcp', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );
  let bridge: BridgeClient | undefined;
  const tools = createMcpTools();
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as Tool['inputSchema'],
      annotations: {
        readOnlyHint:
          !tool.mutating && !['open_document', 'set_active_document', 'job_cancel', 'export_io'].includes(tool.name),
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const tool = tools.find((entry) => entry.name === request.params.name);
    let result;
    if (!tool) result = failure('UNKNOWN_TOOL', 'Unknown Brickloop tool.');
    else if (!tool.schema.safeParse(request.params.arguments ?? {}).success)
      result = failure('INVALID_ARGUMENTS', 'Tool arguments do not match the schema.');
    else {
      const client = server.getClientVersion();
      bridge ??= new BridgeClient({
        ...options,
        client: { name: client?.name ?? 'MCP client', version: client?.version ?? 'unknown' },
      });
      try {
        result = await bridge.call(tool.name, request.params.arguments ?? {}, { signal: extra.signal });
      } catch (error) {
        result =
          error instanceof BridgeError
            ? failure(error.code, error.message)
            : failure('BRIDGE_ERROR', 'The Brickloop bridge could not complete the operation.');
      }
    }
    return {
      isError: !result.ok,
      content: resultContent(result).map((block) =>
        block.type === 'text' ? block : { type: 'image', data: block.base64, mimeType: block.mime },
      ),
    };
  });
  server.onclose = () => bridge?.close();
  return server;
}
