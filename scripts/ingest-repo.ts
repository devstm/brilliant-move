import axios from 'axios'
import {Pool} from 'pg'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const REPO = 'devstm/herfa-next'
const FOLDERS = ['app', 'components', 'lib']
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

async function fetchFiles(path: string): Promise<any[]> {
  const url = `https://api.github.com/repos/${REPO}/contents/${path}`
  const response = await axios.get(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
    }
  })

  let allFiles: any[] = []

  for (const item of response.data) {
    if (item.type === 'file' && EXTENSIONS.some(ext => item.name.endsWith(ext))) {
      allFiles.push(item)
    } else if (item.type === 'dir') {
      const subFiles = await fetchFiles(item.path)
      allFiles = allFiles.concat(subFiles)
    }
  }

  return allFiles
}

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

function chunkCode(content: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < content.length) {
    chunks.push(content.slice(start, start + chunkSize))
    start += chunkSize - overlap
  }
  return chunks
}

async function ingestFile(filename: string, content: string, repo: string) {
  const chunks = chunkCode(content)
  let stored = 0

  for (const chunk of chunks) {
    if (chunk.trim().length < 30) continue
    const embedding = await embed(chunk)
    await pool.query(
      `INSERT INTO codebase_chunks (content, embedding, filename, repo)
       VALUES ($1, $2, $3, $4)`,
      [chunk, JSON.stringify(embedding), filename, repo]
    )
    stored++
  }

  console.log(`Ingested ${stored} chunks from ${filename}`)
}

async function main() {
  console.log(`Indexing ${REPO}...`)

  let allFiles: any[] = []
  for (const folder of FOLDERS) {
    const files = await fetchFiles(folder)
    allFiles = allFiles.concat(files)
  }

  console.log(`Found ${allFiles.length} files`)

  for (const file of allFiles) {
    try {
      const response = await axios.get(file.download_url)
      await ingestFile(file.path, response.data, REPO)
    } catch (err) {
      console.error(`Failed: ${file.path}`, err)
    }
  }

  console.log('Done!')
  await pool.end()
}

main().catch(console.error)