import { type EmbeddingModel, embedMany } from "ai";

export async function embedTexts(model: EmbeddingModel, values: string[]): Promise<number[][]> {
  if (!values.length) return [];
  const { embeddings } = await embedMany({ model, values });
  return embeddings;
}

/** pgvector literal. */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
