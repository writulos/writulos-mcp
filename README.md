# writulos-mcp

Official MCP server for [Writulos Scribe](https://scribe.writulos.com) — generate markdown documentation for your code inside Cursor, Claude Desktop, and any MCP-compatible AI agent.

## Installation

No install needed. Run directly with `npx`:

```bash
npx writulos-mcp
```

Or install globally:

```bash
npm install -g writulos-mcp
```

## Setup in Cursor

Add this to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "writulos": {
      "command": "npx",
      "args": ["-y", "writulos-mcp"],
      "env": {
        "WRITULOS_API_KEY": "writ_YOUR_API_KEY"
      }
    }
  }
}
```

Restart Cursor. Then in the AI chat, ask:

```
Document all the files in this project using writulos
```

The generated docs come back in the chat — ask Cursor to save them wherever you
keep documentation. The server itself only writes a run log to
`docs/writulos.log` (set `WRITULOS_OUTPUT_DIR` to move it), recording each run
and how many generations you have left this month.

## Setup in Claude Code, Claude Desktop and other clients

Use the same `command`, `args` and `env` as the Cursor config above. Whichever
way the client adds the server, give it `WRITULOS_API_KEY`: without the key the
server still starts, and every tool call answers with where to get one.

## Usage and limits

Each file documented uses one generation from your Writulos plan's monthly
allowance, the same allowance the dashboard and the GitHub Action draw on. When
it runs out, the tools say so and when it resets.

## Tools

### `generate_docs`
Generate markdown documentation for a single code file.

**Inputs:**
- `code` (required) — the source code
- `filename` (optional) — e.g. `auth.js`
- `context` (optional) — extra context about the file

### `generate_docs_batch`
Generate markdown documentation for up to 20 files in one request.

**Inputs:**
- `files` (required) — array of `{ code, filename?, context? }` objects

## Requirements

- Node.js 18+
- A Writulos Scribe API key from [scribe.writulos.com/dashboard/api-keys](https://scribe.writulos.com/dashboard/api-keys)

## Source and issues

This repository is a copy of the server, updated on every release. Report bugs
and ask questions in its [issues](https://github.com/writulos/writulos-mcp/issues).

## License

MIT
