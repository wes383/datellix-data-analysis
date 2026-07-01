import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * LLM factory: returns corresponding ChatModel based on LLM_PROVIDER env variable
 * Through unified LangChain interface, supports frontend switching from Phase 4 onwards
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
export function createLLM(): BaseChatModel {
  const provider = (process.env.LLM_PROVIDER ?? "openai").toLowerCase();

  switch (provider) {
    case "openai":
      return new ChatOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        // Phase 0 uses lightweight model to verify the pipeline; Phase 1 onwards switches to stronger models
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
      // Zhipu GLM integrated via OpenAI-compatible interface
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
      // Generic OpenAI-compatible provider (custom baseURL + apiKey + model)
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
