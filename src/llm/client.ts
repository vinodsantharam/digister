import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import type { z } from "zod";
import { loadDigisterConfig } from "../config.js";
import type { FetchFn } from "../sources/youtube/channels.js";

export const LLM_TIMEOUT_MS = 120_000;
export const LLM_TEMPERATURE = 0.2;

export interface StructuredDeps {
  /** Model to call; defaults to the configured Ollama chat model. */
  model?: LanguageModel;
  timeoutMs?: number;
}

function defaultModel(): LanguageModel {
  const { ollama } = loadDigisterConfig();
  return createOllama({ baseURL: `${ollama.base_url.replace(/\/+$/, "")}/api` })(ollama.chat_model);
}

const isSchemaFailure = (err: unknown): boolean =>
  NoObjectGeneratedError.isInstance(err) || NoOutputGeneratedError.isInstance(err);

/**
 * Ask the model for JSON matching `schema`. Temperature 0.2, 120 s timeout per attempt,
 * one retry when the output fails schema validation.
 */
export async function generateStructured<S extends z.ZodType>(
  schema: S,
  system: string,
  prompt: string,
  deps: StructuredDeps = {},
): Promise<z.output<S>> {
  const model = deps.model ?? defaultModel();
  const attempt = async (p: string): Promise<z.output<S>> => {
    const { output } = await generateText({
      model,
      system,
      prompt: p,
      temperature: LLM_TEMPERATURE,
      timeout: deps.timeoutMs ?? LLM_TIMEOUT_MS,
      maxRetries: 0,
      output: Output.object({ schema }),
    });
    return output as z.output<S>;
  };
  try {
    return await attempt(prompt);
  } catch (err) {
    if (!isSchemaFailure(err)) throw err;
    return attempt(
      `${prompt}\n\nYour previous answer was not valid JSON for the required schema. Answer again with only valid JSON that matches the schema exactly.`,
    );
  }
}

export interface OllamaStatus {
  reachable: boolean;
  modelPulled: boolean;
  /** reachable and the chat model is pulled. */
  ok: boolean;
  model: string;
  baseUrl: string;
  error?: string;
}

/** GET <base_url>/api/tags and check the chat model is pulled. Never throws. */
export async function ollamaHealthy(
  opts: { baseUrl?: string; model?: string; fetchFn?: FetchFn; timeoutMs?: number } = {},
): Promise<OllamaStatus> {
  let { baseUrl, model } = opts;
  if (!baseUrl || !model) {
    const cfg = loadDigisterConfig().ollama;
    baseUrl ??= cfg.base_url;
    model ??= cfg.chat_model;
  }
  baseUrl = baseUrl.replace(/\/+$/, "");
  const status: OllamaStatus = { reachable: false, modelPulled: false, ok: false, model, baseUrl };
  try {
    const res = await (opts.fetchFn ?? fetch)(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
    if (!res.ok) return { ...status, error: `HTTP ${res.status} from ${baseUrl}/api/tags` };
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    status.reachable = true;
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter((n): n is string => !!n);
    const wanted = model.includes(":") ? model : `${model}:latest`;
    status.modelPulled = names.includes(wanted);
    status.ok = status.modelPulled;
    if (!status.modelPulled) status.error = `model ${model} is not pulled (run: ollama pull ${model})`;
  } catch (err) {
    status.error = `cannot reach Ollama at ${baseUrl}: ${(err as Error).message}`;
  }
  return status;
}
