import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * LLM factory: returns corresponding ChatModel based on LLM_PROVIDER env variable
 * Through unified LangChain interface, supports frontend switching from Phase 4 onwards
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
        model: "gpt-4o-mini",
        temperature: 0,
        streaming: true,
      });

    case "anthropic":
      return new ChatAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: "claude-3-5-sonnet-latest",
        temperature: 0,
        streaming: true,
      });

    case "glm":
      // Zhipu GLM integrated via OpenAI-compatible interface
      return new ChatOpenAI({
        apiKey: process.env.GLM_API_KEY,
        model: "glm-4-plus",
        temperature: 0,
        streaming: true,
        configuration: {
          baseURL: "https://open.bigmodel.cn/api/paas/v4",
        },
      });

    default:
      throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
  }
}
