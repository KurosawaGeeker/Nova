# Daily AI Report

Daily digest generator for The Hacker News AI-related coverage.

## What it does

- fetches fresh items from stable The Hacker News RSS label feeds
- filters for LLM / agent / AI-relevant topics
- asks an OpenAI model to rewrite the report into simple Chinese
- sends the report through QQ Mail SMTP to multiple recipients

## Local run

```bash
cd /Users/xiaoke/Nova/daily-ai-report
npm install
cp .env.example .env
export $(grep -v '^#' .env | xargs)
npm run dev
```

## Required secrets

- `OPENAI_API_KEY`
- `QQ_SMTP_USER`
- `QQ_SMTP_PASS`
- `REPORT_RECIPIENTS`

`QQ_SMTP_PASS` is the QQ Mail SMTP authorization code, not the mailbox login password.
