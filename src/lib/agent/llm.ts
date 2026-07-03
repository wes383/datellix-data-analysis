import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { LlmConfig } from "@/lib/db/schema";

/**
 * LLM factory: returns corresponding ChatModel based on either:
 *   1. A user-provided LlmConfig (per-user settings from user_settings table)
 *   2. The LLM_PROVIDER env variable (project default)
 *
 * Supported providers:
 *   - openai        : Official OpenAI API
 *   - anthropic     : Official Anthropic API
 *   - glm           : Zhipu GLM (via OpenAI-compatible endpoint)
 *   - openai-compat : Any OpenAI-compatible provider with custom baseURL
 *                     (DeepSeek, Moonshot, Together, Groq, OpenRouter, local vLLM, etc.)
 *
 * Extend here when adding new providers; business code only depends on BaseChatModel
 */

/** Create LLM from project-level environment variables (the original behavior). */
function createLLMFromEnv(): BaseChatModel {
  const provider = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();

  switch (provider) {
    case "openai":
      return new ChatOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        temperature: 0,
        streaming: true,
      });

    case "anthropic":
      return new ChatAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest",
        temperature: 0,
        streaming: true,
      });

    case "glm":
      return new ChatOpenAI({
        apiKey: process.env.GLM_API_KEY,
        model: process.env.GLM_MODEL ?? "glm-4-plus",
        temperature: 0,
        streaming: true,
        configuration: {
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
        },
      });

    case "openai-compat": {
      const baseURL = process.env.OPENAI_COMPAT_BASE_URL;
      const apiKey = process.env.OPENAI_COMPAT_API_KEY;
      const model = process.env.OPENAI_COMPAT_MODEL;
      if (!baseURL || !apiKey || !model) {
        throw new Error(
          "openai-compat provider requires OPENAI_COMPAT_BASE_URL, OPENAI_COMPAT_API_KEY, and OPENAI_COMPAT_MODEL env vars",
        );
      }
      return new ChatOpenAI({
        apiKey,
        model,
        temperature: Number(process.env.OPENAI_COMPAT_TEMPERATURE ?? 0),
        streaming: true,
        configuration: { baseURL },
      });
    }

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }
}

/** Create LLM from a user-provided config (per-user settings).
 *
 *  `modelOverride` lets the caller pick a specific model from the config's
 *  `models` array (e.g. the one the user selected in the chat UI). When
 *  omitted, falls back to `models[0]` (the default).
 */
function createLLMFromConfig(config: LlmConfig, modelOverride?: string): BaseChatModel {
  // Resolve which model to use: explicit override → first in models array →
  // legacy `model` field (for backward compat with old encrypted configs).
  const model =
    modelOverride ?? config.models?.[0] ?? config.model ?? "";
  if (!model) {
    throw new Error("No model specified in LLM config");
  }

  switch (config.provider) {
    case "openai":
      return new ChatOpenAI({
        apiKey: config.apiKey,
        model,
        temperature: 0,
        streaming: true,
      });

    case "anthropic":
      return new ChatAnthropic({
        apiKey: config.apiKey,
        model,
        temperature: 0,
        streaming: true,
      });

    case "glm":
      return new ChatOpenAI({
        apiKey: config.apiKey,
        model,
        temperature: 0,
        streaming: true,
        configuration: {
          baseURL: config.baseURL ?? "https://open.bigmodel.cn/api/paas/v4",
        },
      });

    case "openai-compat": {
      if (!config.baseURL) {
        throw new Error("openai-compat provider requires baseURL");
      }
      return new ChatOpenAI({
        apiKey: config.apiKey,
        model,
        temperature: config.temperature ?? 0,
        streaming: true,
        configuration: { baseURL: config.baseURL },
      });
    }

    default:
      throw new Error(`Unknown LLM provider in user config: ${config.provider}`);
  }
}

/**
 * Create a chat model instance.
 * - If `config` is provided, use the user's custom LLM settings.
 * - If `config` is null/undefined, fall back to project-level env vars.
 * - `modelOverride` selects a specific model from the config's `models`
 *   array; when omitted, `models[0]` (the default) is used.
 */
export function createLLM(
  config?: LlmConfig | null,
  modelOverride?: string,
): BaseChatModel {
  if (!config) {
    return createLLMFromEnv();
  }
  return createLLMFromConfig(config, modelOverride);
}
