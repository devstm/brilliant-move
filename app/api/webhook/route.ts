import { App } from '@octokit/app'
import { createHmac } from 'crypto'
import { NextRequest } from 'next/server'
import fs from 'fs'
import Groq from 'groq-sdk'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const app = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: fs.readFileSync(process.env.GITHUB_APP_PRIVATE_KEY_PATH!, 'utf8'),
  webhooks: {
    secret: process.env.GITHUB_WEBHOOK_SECRET!
  }
})

async function analyzeWithAI(diff: string, prTitle: string, prBody: string) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content:
          'You are an expert code reviewer. Analyze the provided pull request diff and return ONLY valid JSON with no explanation, no markdown, and no code fences. The JSON must have exactly these fields: summary (string), issues (string array), security (string array), suggestions (string array), score (number 1-10), verdict (one of: APPROVE, REQUEST_CHANGES, COMMENT).'
      },
      {
        role: 'user',
        content: `PR Title: ${prTitle}\n\nPR Description: ${prBody || 'No description provided.'}\n\nDiff:\n${diff}`
      }
    ]
  })

  const raw = response.choices[0].message.content ?? ''
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(cleaned)
}

function formatReview(review: any, pr: any): string {
  const score: number = review.score
  const scoreEmoji = score >= 8 ? '🟢' : score >= 5 ? '🟡' : '🔴'
  const verdictLabel =
    review.verdict === 'APPROVE'
      ? '✅ APPROVE'
      : review.verdict === 'REQUEST_CHANGES'
      ? '❌ REQUEST CHANGES'
      : '💬 COMMENT'

  const bulletList = (items: string[], fallback: string) =>
    items.length > 0 ? items.map((i: string) => `- ${i}`).join('\n') : `- ${fallback}`

  return `## BrilliantMove AI Review

**Verdict:** ${verdictLabel} &nbsp;|&nbsp; **Score:** ${scoreEmoji} ${score}/10

---

### 📝 Summary
${review.summary}

---

### 🐛 Issues
${bulletList(review.issues, 'No issues found!')}

---

### 🔒 Security
${bulletList(review.security, 'No security concerns found!')}

---

### 💡 Suggestions
${bulletList(review.suggestions, 'No suggestions.')}

---

*Powered by BrilliantMove AI*`
}

function verifySignature(payload: string, signature: string): boolean {
  const hmac = createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!)
  const digest = 'sha256=' + hmac.update(payload).digest('hex')
  return digest === signature
}

export async function POST(request: NextRequest) {
  try {
    const payload = await request.text()
    const signature = request.headers.get('x-hub-signature-256') ?? ''
    const event = request.headers.get('x-github-event') ?? ''

    // Verify the webhook is really from GitHub
    if (!verifySignature(payload, signature)) {
      return Response.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const body = JSON.parse(payload)

    // Only handle PR opened or reopened events
    if (event !== 'pull_request') {
      return Response.json({ message: 'Event ignored' })
    }

    if (body.action !== 'opened' && body.action !== 'reopened') {
      return Response.json({ message: 'Action ignored' })
    }

    const { pull_request, repository, installation } = body

    console.log(`PR opened: #${pull_request.number} - ${pull_request.title}`)

    // Get an installation token to act on the repo
    const octokit = await app.getInstallationOctokit(installation.id)

    // Fetch the PR diff
    const { data: diff } = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      {
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: pull_request.number,
        headers: { accept: 'application/vnd.github.v3.diff' }
      }
    )

    console.log('Diff fetched successfully')
    console.log(diff)

    const review = await analyzeWithAI(diff as string, pull_request.title, pull_request.body ?? '')
    const comment = formatReview(review, pull_request)

    await octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: pull_request.number,
        body: comment
      }
    )

    return Response.json({ message: 'Review posted successfully' })
  } catch (error) {
    console.error('Webhook error:', error)
    return Response.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}