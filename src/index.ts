#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { lucienSetup } from "./tools/setup.js";

const server = new Server(
    {
        name: "lucien",
        version: "0.0.1",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "lucien_setup",
            description:
                "Initialize a Dreaming directory with default Meta pages and git history. Idempotent — running again won't overwrite existing files.",
            inputSchema: {
                type: "object",
                properties: {
                    dreaming_path: {
                        type: "string",
                        description:
                            "Path to the Dreaming directory. Defaults to ~/Dreaming. Tilde (~) is expanded.",
                    },
                },
            },
        },
        {
            name: "ping",
            description: "Health check — returns pong",
            inputSchema: {
                type: "object",
                properties: {},
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "ping") {
        return { content: [{ type: "text", text: "pong" }] };
    }

    if (name === "lucien_setup") {
        const result = await lucienSetup(args as { dreaming_path?: string });
        return { content: [{ type: "text", text: result }] };
    }

    throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);