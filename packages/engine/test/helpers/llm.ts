/**
 * Deterministic LLM test doubles for the turn-gate suites. `controllableLLM`
 * answers each createMessage from a script; a `null` entry hangs the call until
 * release() is invoked, which lets a test hold a turn mid-flight (gate held)
 * with no timer or scheduling dependence.
 */
import type {
  LLMClient,
  LLMCreateParams,
  LLMResponse,
  LLMToolUseBlock,
} from "../../src/llm/types";

export function textResponse(text: string): LLMResponse {
  return {
    id: "msg",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function toolUseResponse(): LLMResponse {
  const block: LLMToolUseBlock = {
    type: "tool_use",
    id: "tu-1",
    name: "mock_email_list",
    input: { label: "INBOX" },
  };
  return {
    id: "msg",
    content: [block],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * An LLM whose calls are answered from a queue: an entry is either an immediate
 * response, or `null` — meaning "hang until release() is called". The last
 * entry repeats for any calls past the script's length.
 */
export function controllableLLM(script: Array<LLMResponse | null>) {
  let i = 0;
  let releaseFn: ((r: LLMResponse) => void) | null = null;
  let rejectFn: ((e: Error) => void) | null = null;
  const client: LLMClient = {
    createMessage(_p: LLMCreateParams): Promise<LLMResponse> {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      if (step !== null) return Promise.resolve(step);
      return new Promise<LLMResponse>((resolve, reject) => {
        releaseFn = resolve;
        rejectFn = reject;
      });
    },
  };
  return {
    client,
    release: (r: LLMResponse) => releaseFn!(r),
    fail: (e: Error) => rejectFn!(e),
  };
}
