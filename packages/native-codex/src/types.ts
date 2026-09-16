/** Data-only projections safe to import into the renderer. */
export interface TextMessage { id:string; text:string }
export interface TextUsage { totalTokens:number; inputTokens:number; outputTokens:number; cachedInputTokens:number; reasoningOutputTokens:number }
