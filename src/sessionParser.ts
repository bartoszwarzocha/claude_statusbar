import * as fs from 'fs';
import * as readline from 'readline';
import { ClaudeMessage, MessageUsage } from './types';

/**
 * Parse a Claude JSONL session file and extract messages with usage data
 */
export async function parseSessionFile(filePath: string, projectName?: string): Promise<ClaudeMessage[]> {
  const messages: ClaudeMessage[] = [];

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
          usage: {
            input_tokens: msg.usage.input_tokens || 0,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens || 0,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
          },
        };

        messages.push(message);
      } catch (err) {
        console.warn(`Failed to parse line in ${filePath}:`, err);
      }
    }
  } catch (err) {
    console.error(`Failed to read session file ${filePath}:`, err);
  }

  return messages;
}

/**
 * Calculate tokens that count toward session limits
 * NOTE: Cache tokens (cache_creation_input_tokens and cache_read_input_tokens)
 * do NOT count toward session limits - only base input_tokens and output_tokens count!
 *
 * This is DIFFERENT from cost calculation, which includes all token types.
 */
export function calculateLimitTokens(usage: MessageUsage): number {
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;

  // Only count input and output - cache tokens don't count toward limits
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
