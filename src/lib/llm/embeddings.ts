import { OpenAIEmbeddings } from "@langchain/openai";

/**
 * Embedding model factory
 *
 * Phase 1 vectors are stored in pgvector (dimension must match the column).
 *
 * Two backends supported:
 *
 * 1. OpenAI-compatible (default): any provider implementing POST /embeddings
 *    with {input: [...]} -> {data: [{embedding: [...]}]}.
 *    Credential resolution order:
 *      a. Explicit EMBEDDING_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL
 *      b. OPENAI_API_KEY (OpenAI native)
 *      c. OPENAI_COMPAT_* (when LLM_PROVIDER=openai-compat) — reuses the
 *         same provider/key/baseURL as the chat model.
 *
 * 2. Cloudflare Workers AI: auto-detected when EMBEDDING_BASE_URL contains
 *    "cloudflare.com". Uses Cloudflare's native /ai/run/{model} endpoint
 *    (different request/response shape from OpenAI). Requires
 *    EMBEDDING_API_KEY + EMBEDDING_BASE_URL + EMBEDDING_MODEL.
 *
 * NOTE: ensure the pgvector column dimension matches your model's output
 * dimension. The default migration uses 1536 (OpenAI text-embedding-3-small).
 * For Cloudflare qwen3-embedding-0.6b (1024-dim), run the dimension-fix
 * migration to resize the column.
 */

export interface EmbeddingsBackend {
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

let cached: EmbeddingsBackend | null = null;

export function createEmbeddings(): EmbeddingsBackend {
  if (cached) return cached;

  const apiKey =
    process.env.EMBEDDING_API_KEY ??
    process.env.OPENAI_API_KEY ??
    process.env.OPENAI_COMPAT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Embeddings require EMBEDDING_API_KEY (or OPENAI_API_KEY / OPENAI_COMPAT_API_KEY as fallback). " +
        "Set EMBEDDING_BASE_URL / EMBEDDING_MODEL for OpenAI-compatible providers.",
    );
  }

  const baseURL =
    process.env.EMBEDDING_BASE_URL ?? process.env.OPENAI_COMPAT_BASE_URL;
  const model =
    process.env.EMBEDDING_MODEL ??
    (process.env.LLM_PROVIDER === "openai-compat"
      ? process.env.OPENAI_COMPAT_MODEL ?? "text-embedding-3-small"
      : "text-embedding-3-small");

  // Auto-detect Cloudflare Workers AI backend
  if (baseURL && /cloudflare\.com/i.test(baseURL)) {
    if (!process.env.EMBEDDING_API_KEY || !process.env.EMBEDDING_BASE_URL || !process.env.EMBEDDING_MODEL) {
      throw new Error(
        "Cloudflare embeddings require EMBEDDING_API_KEY, EMBEDDING_BASE_URL, and EMBEDDING_MODEL.",
      );
    }
    cached = new CloudflareEmbeddingsBackend(
      apiKey,
      baseURL,
      model,
    );
    return cached;
  }

  // Default: OpenAI-compatible
  const openai = new OpenAIEmbeddings({
    apiKey,
    model,
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
  cached = {
    embedText: async (text: string) => (await openai.embedDocuments([text]))[0],
    embedBatch: async (texts: string[]) => openai.embedDocuments(texts),
  };
  return cached;
}

/**
 * Cloudflare Workers AI embedding backend.
 *
 * Endpoint: POST {accountUrl} (already includes /ai/run/{model})
 * Request:  { text: string | string[] }
 * Response: { success: true, result: { data: number[][], shape: [n, dim] } }
 *
 * The API key is a Cloudflare API token passed as Bearer.
 */
class CloudflareEmbeddingsBackend implements EmbeddingsBackend {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
    private readonly model: string,
  ) {}

  private async call(texts: string[]): Promise<number[][]> {
    // Cloudflare accepts { text: string | string[] }; single-string path returns
    // a single embedding, array path returns an array. We always pass an array
    // to keep the response shape consistent.
    const body = JSON.stringify({ text: texts });
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(
        `Cloudflare embeddings request failed: ${res.status} ${errText.slice(0, 300)}`,
      );
    }

    const json = (await res.json()) as {
      success?: boolean;
      errors?: Array<{ message: string }>;
      result?: { data?: number[][]; shape?: [number, number] };
    };

    if (!json.success || !json.result?.data) {
      const msg = json.errors?.[0]?.message ?? "unknown error";
      throw new Error(`Cloudflare embeddings error: ${msg}`);
    }

    return json.result.data;
  }

  async embedText(text: string): Promise<number[]> {
    const [vec] = await this.call([text]);
    if (!vec) throw new Error("Cloudflare returned no embedding");
    return vec;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    // Cloudflare accepts arrays; chunk to keep request size reasonable.
    const CHUNK = 32;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const chunk = texts.slice(i, i + CHUNK);
      const vecs = await this.call(chunk);
      out.push(...vecs);
    }
    return out;
  }
}

/** Embed a single text and return the vector (number[]) */
export async function embedText(text: string): Promise<number[]> {
  const embeddings = createEmbeddings();
  return embeddings.embedText(text);
}

/** Embed multiple texts in a single batch call */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embeddings = createEmbeddings();
  return embeddings.embedBatch(texts);
}
