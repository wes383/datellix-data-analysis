import { StateGraph, END, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { Pool } from "pg";
import { AgentState } from "./state";
import { createLLM } from "./llm";

/**
 * LangGraph state graph
 *
 * Phase 0: minimal skeleton, only one echo node to verify:
 *   - Streaming output pipeline
 *   - Supabase Postgres Saver persistence
 *   - SSE streaming
 *
 * Phase 1 onwards replaces with full state graph from PRD §6.3:
 *   __start__ → schemaRetriever → router → {nlSql | summarize | makeChart} → synthesizer → END
 */

// Reuse Postgres connection pool (LangGraph Saver connects directly to Supabase)
let pool: Pool | null = null;
let checkpointer: PostgresSaver | null = null;

async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointer) return checkpointer;

  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  checkpointer = PostgresSaver.fromConnString(process.env.DATABASE_URL!);
  await checkpointer.setup(); // Auto-create checkpoint table (skipped if already created)
  return checkpointer;
}

/** echo node: echoes user input, used in Phase 0 to verify the pipeline */
async function echoNode(state: typeof AgentState.State) {
  const llm = createLLM();
  const response = await llm.invoke([
    new HumanMessage(
      `You are the Datellix data analysis assistant (Phase 0 skeleton). The user said: "${state.question}".\nPlease briefly reply to confirm receipt, and explain that full features will be available in later phases.`,
    ),
  ]);

  return {
    messages: [new AIMessage(response.content as string)],
  };
}

/** Build and compile the state graph */
export async function getGraph() {
  const cp = await getCheckpointer();

  const graph = new StateGraph(AgentState)
    .addNode("echo", echoNode)
    .addEdge(START, "echo")
    .addEdge("echo", END)
    .compile({ checkpointer: cp });

  return graph;
}

/**
 * Run the Agent and return a streaming event iterator
 *
 * @param sessionId LangGraph thread_id (session-level persistence)
 * @param question  user question
 */
export async function* streamAgent(sessionId: string, question: string) {
  const graph = await getGraph();

  const stream = await graph.stream(
    { sessionId, question, messages: [new HumanMessage(question)] },
    { configurable: { thread_id: sessionId }, streamMode: "messages" },
  );

  for await (const chunk of stream) {
    yield chunk;
  }
}

/** Release connection pool (called on app shutdown, optional in Vercel Serverless) */
export async function closeGraph(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  checkpointer = null;
}
