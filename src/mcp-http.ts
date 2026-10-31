import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { type Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1_000_000;

export interface McpHttpOptions {
  /** The bearer token an MCP client must present. Compared in constant time. */
  readonly bearerToken: string;
  /** Builds a fresh MCP server for each request. The endpoint keeps no session state. */
  readonly createMcpServer: () => Server;
}

/**
 * Serves the MCP server over streamable HTTP at POST /mcp. Every request must
 * carry the bearer token. The server is stateless: each request gets its own
 * MCP server and transport, closed when the response ends. Every tool call
 * still goes to Parmana first, so this endpoint never decides policy itself.
 */
export function createMcpHttpServer(options: McpHttpOptions): HttpServer {
  const expected = Buffer.from(`Bearer ${options.bearerToken}`);

  return createServer(async (req, res) => {
    try {
      if (!isAuthorized(req, expected)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="parmana-connect"');
        return send(res, 401, "unauthorized");
      }
      if (new URL(req.url ?? "/", "http://localhost").pathname !== MCP_PATH) {
        return send(res, 404, "not found");
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return send(res, 405, "method not allowed");
      }

      const body = await readJsonBody(req, MAX_BODY_BYTES);
      if (body === undefined) {
        return send(res, 400, "the body must be JSON, and at most 1 MB");
      }

      const server = options.createMcpServer();
      // No session id generator: the transport runs stateless.
      const transport = new StreamableHTTPServerTransport();
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      // Say nothing about the cause; the detail is for the operator's logs, not the caller.
      if (!res.headersSent) send(res, 500, "internal error");
    }
  });
}

function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}
