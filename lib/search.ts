import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function embed(text: string): Promise<number[]> {
  const response = await fetch(
    'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2/pipeline/feature-extraction',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ inputs: text })
    }
  )

  if (!response.ok) throw new Error(`Embedding failed: ${response.status}`)
  return response.json() as Promise<number[]>
}

export async function searchCodebase(query: string, repo: string, topK = 5) {
  const queryEmbedding = await embed(query)

  const result = await pool.query(
    `SELECT content, filename,
     ROUND((1 - (embedding <=> $1))::numeric, 4) AS similarity
     FROM codebase_chunks
     WHERE repo = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [JSON.stringify(queryEmbedding), repo, topK]
  )

  return result.rows
}