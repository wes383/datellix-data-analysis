import { Annotation, MessagesAnnotation } from "@langchain/langgraph";

/**
 * Agent state definition (AgentState)
 *
 * Corresponds to PRD §6.2. Phase 0 starts with minimal state (messages only),
 * Phase 1+ gradually adds fields like schemaContext / sqlResults / artifacts.
 *
 * Uses MessagesAnnotation built-in messages field (with reducer, auto-merged)
 */
export const AgentState = Annotation.Root({
  ...MessagesAnnotation,
  /** Current session id (used as LangGraph thread_id) */
  sessionId: Annotation<string>,
  /** Current user question */
  question: Annotation<string>,
});

export type AgentStateType = typeof AgentState.State;
