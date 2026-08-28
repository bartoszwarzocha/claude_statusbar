import * as fs from 'fs';
import * as readline from 'readline';
import { ClaudeMessage, MessageUsage, TranscriptMeta } from './types';

/**
 * Parse a Claude JSONL session file and extract messages with usage data
 */
export async function parseSessionFile(filePath: string, projectName?: string): Promise<ClaudeMessage[]> {
  return (await parseSessionFileWithMeta(filePath, projectName)).messages;
}

export interface ParsedSessionFile {
  messages: ClaudeMessage[];
  /** Session-level facts, used to list every open session - see TranscriptMeta */
  meta: TranscriptMeta;
}

/**
 * Parse a transcript once, returning both its messages and the session facts.
 *
 * Reading the file twice would double the most expensive part of a refresh, so
 * the metadata is collected in the same pass. Note that it is gathered *before*
 * the message filters below: `ai-title` lines carry no `message` at all, and a
 * reply that spent its whole budget on cache reads still tells us how full the
 * context window is.
 */
export async function parseSessionFileWithMeta(
  filePath: string,
  projectName?: string
): Promise<ParsedSessionFile> {
  const messages: ClaudeMessage[] = [];
  const meta: TranscriptMeta = {};

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue; // Skip empty lines
      }

      try {
        const parsed = JSON.parse(line);

        collectMeta(meta, parsed);

        // Skip non-message entries (summaries, etc.)
        if (parsed.type === 'summary' || !parsed.message) {
          continue;
        }

        // Extract relevant fields from the nested message structure
        const msg = parsed.message;

        // Skip messages without usage data (Python does this in reader.py:244-245)
        if (!msg.usage) {
          continue;
        }

        // Skip messages with zero tokens (Python checks: if not any(v for k, v in token_data.items()))
        const hasTokens =
          (msg.usage.input_tokens && msg.usage.input_tokens > 0) ||
          (msg.usage.output_tokens && msg.usage.output_tokens > 0);

        if (!hasTokens) {
          continue;
        }

        // Extract model from various possible locations (matching Python's DataConverter.extract_model_name)
        const modelCandidates = [
          msg.model,              // message.model
          parsed.model,           // root.model
          parsed.Model,           // root.Model (capitalized)
          msg.usage?.model,       // usage.model
          parsed.request?.model,  // request.model
        ];

        const model = modelCandidates.find(m => m && typeof m === 'string') || undefined;

        const message: ClaudeMessage = {
          id: msg.id || parsed.uuid || '',
          requestId: parsed.request_id || parsed.requestId || 'unknown',
          timestamp: parsed.timestamp || new Date().toISOString(),
          role: msg.role || 'user',
          model: model,
          projectName: projectName,
          usage: extractUsage(msg.usage),
        };

        messages.push(message);
      } catch (err) {
        console.warn(`Failed to parse line in ${filePath}:`, err);
      }
    }
  } catch (err) {
    console.error(`Failed to read session file ${filePath}:`, err);
  }

  return { messages, meta };
}

/**
 * Fold one transcript line into the session facts.
 *
 * Every line repeats `sessionId`, `cwd` and `entrypoint`, and a session can
 * change entrypoint mid-life - resuming a CLI conversation inside the VS Code
 * extension is common - so the last line wins.
 */
function collectMeta(meta: TranscriptMeta, parsed: any): void {
  if (typeof parsed.sessionId === 'string') {
    meta.sessionId = parsed.sessionId;
  }
  if (typeof parsed.cwd === 'string') {
    meta.cwd = parsed.cwd;
  }
  if (typeof parsed.entrypoint === 'string') {
    meta.entrypoint = parsed.entrypoint;
  }
  if (parsed.type === 'ai-title' && typeof parsed.aiTitle === 'string') {
    meta.title = parsed.aiTitle;
  }
  if (typeof parsed.timestamp === 'string') {
    const at = new Date(parsed.timestamp);
    if (!isNaN(at.getTime())) {
      meta.lastActivity = at;
    }
  }

  // Context usage. Sidechain replies belong to subagents, which carry their own
  // window, so counting them would report a context the session does not have.
  if (parsed.type !== 'assistant' || parsed.isSidechain === true) {
    return;
  }
  const usage = parsed.message?.usage;
  if (!usage) {
    return;
  }
  const resident =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  if (resident > 0) {
    meta.contextTokens = resident;
    if (typeof parsed.message?.model === 'string') {
      meta.model = parsed.message.model;
    }
  }
}

/**
 * Extract a normalized MessageUsage from a raw JSONL usage object.
 *
 * Beyond the four token counters, current Claude Code transcripts carry fields
 * that materially change cost: the per-TTL cache split (1-hour writes cost 2x
 * base input, not 1.25x), fast mode, US-only inference, and server tool calls.
 */
export function extractUsage(raw: any): MessageUsage {
  const usage: MessageUsage = {
    input_tokens: raw.input_tokens || 0,
    cache_creation_input_tokens: raw.cache_creation_input_tokens || 0,
    cache_read_input_tokens: raw.cache_read_input_tokens || 0,
    output_tokens: raw.output_tokens || 0,
  };

  // Per-TTL cache creation split (present since the 1h cache shipped)
  const cc = raw.cache_creation;
  if (cc && typeof cc === 'object') {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: cc.ephemeral_5m_input_tokens || 0,
      ephemeral_1h_input_tokens: cc.ephemeral_1h_input_tokens || 0,
    };
  }

  if (typeof raw.speed === 'string') {
    usage.speed = raw.speed;
  }
  if (typeof raw.inference_geo === 'string') {
    usage.inference_geo = raw.inference_geo;
  }
  if (typeof raw.service_tier === 'string') {
    usage.service_tier = raw.service_tier;
  }

  const st = raw.server_tool_use;
  if (st && typeof st === 'object') {
    usage.server_tool_use = {
      web_search_requests: st.web_search_requests || 0,
      web_fetch_requests: st.web_fetch_requests || 0,
      code_execution_requests: st.code_execution_requests || 0,
    };
  }

  return usage;
}

/**
 * Calculate tokens that count toward session limits
 *
 * Based on empirical testing with Claude-Code-Usage-Monitor:
 * - input_tokens: ✓ COUNT toward limits
 * - output_tokens: ✓ COUNT toward limits
 * - cache_creation_input_tokens: ✗ DO NOT count toward limits
 * - cache_read_input_tokens: ✗ DO NOT count toward limits
 *
 * Cache tokens affect COST but NOT session limits.
 * This is DIFFERENT from cost calculation, which includes ALL token types with different pricing.
 *
 * Empirical evidence from Maciek's monitor shows only ~7k tokens counted vs 2M+ when including cache.
 *
 * Sources:
 * - https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor
 * - Real-world testing: 7,243 tokens (8.2%) vs 2M+ tokens (2289%) with cache included
 */
export function calculateLimitTokens(usage: MessageUsage): number {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  // Count ONLY input and output - cache tokens don't count toward limits
  // (but they DO cost money)
  return inputTokens + outputTokens;
}

/**
 * Extract session ID from file path
 * Example: /path/to/abc123-def456.jsonl -> abc123-def456
 */
export function extractSessionId(filePath: string): string {
  const match = filePath.match(/([^/\\]+)\.jsonl$/);
  return match ? match[1] : 'unknown';
}
