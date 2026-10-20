#!/usr/bin/env node
/**
 * Writulos MCP Server
 *
 * Configuration (env vars):
 *   WRITULOS_API_KEY        — required
 *   WRITULOS_API_URL        — optional, defaults to https://scribe.writulos.com/api
 *   WRITULOS_OUTPUT_DIR     — optional, defaults to "docs" relative to project root
 *   WRITULOS_PROJECT_ROOT   — optional, defaults to process.cwd()
 *
 * Log file:
 *   Written to <outputDir>/writulos.log alongside generated docs.
 *   Created on first run, appended to on every subsequent run.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

// Read the version off the manifest rather than repeating it here. Hardcoded,
// it silently went stale the first time the package was republished, and every
// MCP client shows this number in its server list.
const { version: VERSION } = createRequire(import.meta.url)('./package.json');

const API_KEY      = process.env.WRITULOS_API_KEY ?? '';
const BASE_URL     = (process.env.WRITULOS_API_URL ?? 'https://scribe.writulos.com/api').replace(/\/$/, '');
const PROJECT_ROOT = process.env.WRITULOS_PROJECT_ROOT ?? process.cwd();
const OUTPUT_DIR   = process.env.WRITULOS_OUTPUT_DIR ?? 'docs';
const OUTPUT_DIR_ABS = path.resolve(PROJECT_ROOT, OUTPUT_DIR);
const LOG_FILE     = path.join(OUTPUT_DIR_ABS, 'writulos.log');

// Without a key the server still starts and lists its tools; each call answers
// with how to get one. Exiting here showed most clients only "server failed to
// start", with the reason in a log nobody opens, and left registries that list
// tools by starting the server with nothing to show.
const KEY_URL = 'https://scribe.writulos.com/dashboard/api-keys';
const PRICING_URL = 'https://scribe.writulos.com/pricing';
const MISSING_KEY = `WRITULOS_API_KEY is not set. Create a key at ${KEY_URL} ` +
  'and add it to this server\'s "env" in your MCP client config, then restart the client.';
if (!API_KEY) console.error(`[writulos-mcp] ${MISSING_KEY}`);

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

// ---------------------------------------------------------------------------
// Persistent log — appends to docs/writulos.log, never overwrites
// ---------------------------------------------------------------------------
function appendLog({ succeeded, total, remaining, limitReached, message }) {
  try {
    if (!fs.existsSync(OUTPUT_DIR_ABS)) fs.mkdirSync(OUTPUT_DIR_ABS, { recursive: true });

    const isNew = !fs.existsSync(LOG_FILE);
    const ts     = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const status = limitReached ? 'LIMIT REACHED' : 'OK';
    const lines  = [];

    if (isNew) {
      lines.push(
        '# Writulos Log\n#\n# This file is created and maintained automatically by Writulos.',
        '# Every run appends a new entry — it is never overwritten.',
        '#',
        '# What to do with this file:',
        '#   - Keep it to track your documentation history and monthly quota.',
        '#   - If you see a NOTIFICATION entry, follow the link inside it.',
        '#   - You can safely delete this file — it will be recreated on the next run.',
        '#',
        '',
      );
    }

    lines.push(`[${ts}] MCP — ${status}`);
    lines.push(`  Files: ${succeeded}/${total} documented`);
    if (!limitReached && remaining != null) lines.push(`  Remaining: ${remaining} generations this month`);
    if (limitReached) lines.push(`  NOTIFICATION: ${message}`);
    lines.push('');

    fs.appendFileSync(LOG_FILE, lines.join('\n'), 'utf8');
    console.error(`[writulos-mcp] log updated → ${LOG_FILE}`);
  } catch (err) {
    console.error('[writulos-mcp] Could not write log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function callWritulos(endpoint, body) {
  if (!API_KEY) throw new Error(MISSING_KEY);

  let res;
  try {
    res = await fetch(`${BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Writulos at ${BASE_URL} (${err.cause?.code ?? err.cause?.errors?.[0]?.code ?? err.message}). Check your connection and try again.`);
  }

  // A platform timeout or gateway error answers in HTML or plain text; read
  // as JSON it surfaced as "Unexpected token" instead of the status.
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }

  if (res.status === 401) throw new Error(`Writulos did not accept this API key. Check WRITULOS_API_KEY, or create a new key at ${KEY_URL}.`);
  if (res.status === 429) {
    return {
      __limitReached: true,
      daysLeft: data?.daysLeft ?? 0,
      isPro: data?.isPro === true || data?.showProBanner === false,
      message: limitMessage(data),
      // Batch 429s still carry the docs generated before the limit hit —
      // don't throw those away.
      docs: data?.docs,
      summary: data?.summary,
    };
  }
  if (!res.ok) throw new Error(`Writulos API error: ${data?.error ?? `HTTP ${res.status}`}`);
  if (!data) throw new Error(`Writulos API error: unreadable response (HTTP ${res.status}). Try again.`);
  return data;
}

/**
 * The server's own words for a limit: it knows whether it was a personal
 * plan, a team's pool or the per-person cap a team owner set, and how many
 * generations that was. Restating it here hardcoded "10/month" into 1.0.2
 * long after Free became 20, and told a capped team seat to upgrade.
 */
function limitMessage(data) {
  const text = data?.error ?? `Monthly limit reached. Resets in ${data?.daysLeft ?? 0} day(s).`;
  return data?.showProBanner === true ? `${text} Upgrade → ${PRICING_URL}` : text;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'writulos', version: VERSION });

// Each call spends a generation from the account's monthly pool and appends
// to the run log, so neither tool is read-only or idempotent; neither deletes
// anything, and both reach an outside service.
const ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

server.registerTool(
  'generate_docs',
  {
    title: 'Generate docs for a file',
    description: 'Generate markdown documentation for a single code file using Writulos. Uses one generation from the account\'s monthly allowance.',
    inputSchema: {
      code:     z.string().min(1).describe('The source code to document.'),
      filename: z.string().optional().describe('The filename, e.g. auth.js'),
      context:  z.string().optional().describe('Optional extra context about the file or project.'),
    },
    annotations: ANNOTATIONS,
  },
  async ({ code, filename, context }) => {
    const data = await callWritulos('generate', { code, filename, context });

    if (data.__limitReached) {
      appendLog({ succeeded: 0, total: 1, remaining: 0, limitReached: true, message: data.message });
      return { content: [{ type: 'text', text: `⚠️ Writulos: ${data.message}` }], isError: true };
    }

    appendLog({ succeeded: 1, total: 1, remaining: data.remaining ?? null, limitReached: false });
    return { content: [{ type: 'text', text: data.documentation ?? JSON.stringify(data) }] };
  }
);

server.registerTool(
  'generate_docs_batch',
  {
    title: 'Generate docs for several files',
    description: 'Generate markdown documentation for multiple code files in one request (up to 20 files). Uses one generation per file from the account\'s monthly allowance.',
    inputSchema: {
      files: z
        .array(z.object({
          code:     z.string().min(1).describe('The source code to document.'),
          filename: z.string().optional().describe('The filename, e.g. auth.js'),
          context:  z.string().optional().describe('Optional extra context about this file.'),
        }))
        .min(1).max(20)
        .describe('Array of files to document. Maximum 20 per request.'),
    },
    annotations: ANNOTATIONS,
  },
  async ({ files }) => {
    const data = await callWritulos('agent-generate-batch', { files });

    if (data.__limitReached) {
      const partialDocs = (data.docs ?? []).filter(d => !d.error);
      appendLog({ succeeded: partialDocs.length, total: files.length, remaining: 0, limitReached: true, message: data.message });
      const partialText = partialDocs.length > 0
        ? partialDocs.map((doc) => `## ${doc.filename ?? '(unnamed file)'}\n\n${doc.documentation}`).join('\n\n---\n\n') + '\n\n---\n\n'
        : '';
      return {
        content: [{ type: 'text', text: `${partialText}⚠️ Writulos: ${data.message}${partialDocs.length > 0 ? ` (${partialDocs.length}/${files.length} files were documented before the limit)` : ''}` }],
        // Some docs came back, so the call did part of its job.
        isError: partialDocs.length === 0,
      };
    }

    const succeeded = (data.docs ?? []).filter(d => !d.error).length;

    appendLog({
      succeeded,
      total:        files.length,
      remaining:    data.summary?.remaining ?? null,
      limitReached: false,
    });

    const sections = (data.docs ?? []).map((doc) => {
      const header = doc.filename ? `## ${doc.filename}` : '## (unnamed file)';
      const body   = doc.error ? `> ⚠️ Error: ${doc.error}` : (doc.documentation ?? 'No documentation returned.');
      return `${header}\n\n${body}`;
    });

    const summaryLine = data.summary ? `\n\n---\n✅ ${data.summary.succeeded}/${data.summary.total} files documented` : '';

    return { content: [{ type: 'text', text: sections.join('\n\n---\n\n') + summaryLine }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[writulos-mcp] Server running. Log will be written to: ${LOG_FILE}`);
}

main().catch((err) => {
  console.error('[writulos-mcp] Fatal error:', err);
  process.exit(1);
});
