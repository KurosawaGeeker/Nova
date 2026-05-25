# Pricing and Entitlements Implementation PRD

## Purpose

This PRD defines the implementation plan for Nova pricing, credits, entitlements, and usage accounting. It is written for coding agents.

Human-facing pricing strategy is documented in Chinese in `docs/pricing-strategy.md`. This implementation PRD must remain behavior-focused and use English.

## Product Principles

- Users should not feel afraid to ask questions.
- Audio generation minutes are the primary hard-cost unit and must be tracked strictly.
- Cloud storage is a visible entitlement and should be tracked separately.
- Ask usage should be tracked for fair use, but should not create a strong "one question deducted" product feeling.
- Failed generation must not charge the user.
- Retry attempts must not double charge.
- Replays, re-downloads, and listening to already generated content must not charge generation credits.

## Billing Units

### AI Audio Minutes

`ai_audio_minutes` are consumed when Nova successfully produces playable audio.

Usage sources:

- Article audiobook generation.
- Whole-book chapter audiobook generation.
- AI spoken answer generation, if the product chooses to account spoken answers against this pool.
- User-owned media transcription-to-audio workflows in future phases, if audio is generated.

Charging rule:

- Charge only after a chapter or audio artifact reaches a successful `READY` state.
- Charge by actual generated audio duration, rounded up to the nearest second internally.
- Display rounded minutes to the user.

No charge:

- import preview
- discovery
- fetch failure
- preprocessing failure
- adaptation failure
- TTS failure
- packaging failure
- automatic retry attempts
- replay
- re-download
- local playback

### Cloud Storage

Cloud storage is measured by bytes stored in Nova-managed remote storage.

Usage sources:

- generated audio files
- subtitles
- transcript files
- semantic script files
- cover images
- manifests

Charging rule:

- Track actual object bytes.
- Apply plan quota in GB.
- Local-only files do not count.

### Ask Fair Use

Ask usage tracks user questions and internal cost intensity.

User-facing rule:

- Do not present Ask as a strict per-question hard quota in primary UI.
- Use phrases such as "high-quality Ask", "fair use", or "advanced Ask" only where needed.

Internal accounting dimensions:

- `ask_count`
- `ask_text_tokens_in`
- `ask_text_tokens_out`
- `ask_stt_seconds`
- `ask_tts_seconds`
- `ask_web_search_calls`
- `ask_cost_score`

No charge/fair-use count:

- STT failure
- model failure
- TTS failure
- user cancellation
- timeout before answer is available
- empty answer

## Plans

Implement plans as data, not hardcoded conditionals.

### Free

Entitlements:

- local library: unlimited
- cloud storage: `1GB`
- first-month AI audio minutes: `30`
- monthly restored AI audio minutes after first month: `10`
- basic Ask: available
- high-quality Ask: fair-use limited

### Starter

Price target:

- `CNY 28/month`
- optional international price: `USD 4.99/month`

Entitlements:

- cloud storage: `3GB`
- monthly AI audio minutes: `100`
- high-quality Ask: fair use

### Pro

Price target:

- `CNY 58/month`
- optional international price: `USD 9.99/month`

Entitlements:

- cloud storage: `10GB`
- monthly AI audio minutes: `300`
- higher high-quality Ask fair use
- priority voice answer and web-enhanced answer behavior

### Heavy

Price target:

- `CNY 168/month`

Entitlements:

- cloud storage: `80GB`
- monthly AI audio minutes: `800`
- heavy Ask fair use
- higher concurrency and longer context, where supported

Alternative Heavy option:

- `CNY 128/month`
- cloud storage: `50GB`
- monthly AI audio minutes: `500`

### Add-ons

AI audio minutes:

- `100 minutes`
- `500 minutes`

Cloud storage:

- `20GB`
- `100GB`

Do not prioritize Ask add-ons for V1 unless business requirements change.

## Domain Model

### UserAccount

Fields:

- `id`
- `createdAt`
- `updatedAt`
- `billingRegion`
- `planId`
- `planStatus`: `free | trialing | active | past_due | canceled`
- `currentPeriodStart`
- `currentPeriodEnd`

### Plan

Fields:

- `id`
- `name`
- `monthlyPriceCny`
- `monthlyPriceUsd?`
- `cloudStorageBytes`
- `monthlyAiAudioSeconds`
- `firstMonthAiAudioSeconds?`
- `askFairUseTier`: `free | starter | pro | heavy`
- `maxConcurrentImports`
- `maxContextTokens`
- `createdAt`
- `updatedAt`

### CreditBalance

Fields:

- `userId`
- `periodAiAudioSecondsGranted`
- `periodAiAudioSecondsUsed`
- `addonAiAudioSecondsRemaining`
- `periodStartedAt`
- `periodEndsAt`
- `updatedAt`

Consumption order:

1. monthly restored period credits
2. add-on credits

### StorageUsage

Fields:

- `userId`
- `cloudStorageBytesUsed`
- `lastCalculatedAt`

Storage usage may be recalculated from object storage metadata for consistency.

### UsageLedger

Append-only ledger for auditability.

Fields:

- `id`
- `userId`
- `bookId?`
- `chapterId?`
- `operationId`
- `usageType`: `audio_generation | ask | storage_delta | credit_grant | credit_refund`
- `quantity`
- `unit`: `seconds | bytes | count | cost_score`
- `status`: `pending | committed | canceled | refunded`
- `reason`
- `idempotencyKey`
- `createdAt`
- `committedAt?`

Requirements:

- All chargeable operations must use idempotency keys.
- Retried jobs must reuse the same operation identity or explicitly link attempts to the same charge group.
- Never double charge a successful retry.

### ImportAttempt

Fields:

- `id`
- `jobId`
- `chapterId`
- `attemptIndex`
- `status`
- `startedAt`
- `endedAt?`
- `errorCode?`
- `isRetryable`

## Charging State Machine

### Chapter Generation

States:

- `QUEUED`
- `FETCHING`
- `PREPROCESSING`
- `ADAPTING`
- `SYNTHESIZING`
- `PACKAGING`
- `READY`
- `FAILED`

Charging lifecycle:

1. On user confirmation, validate that the user has enough estimated or minimum required credits.
2. Create a pending `UsageLedger` entry with `usageType=audio_generation`.
3. Run chapter pipeline.
4. If chapter fails, cancel pending ledger entry.
5. If retryable failure occurs, keep the pending ledger entry and attach retry attempts.
6. If final attempt succeeds, measure actual audio duration.
7. Commit the pending ledger entry using actual generated seconds.
8. Decrement credit balance once.

Important:

- Do not commit on TTS chunk success.
- Commit only after the final chapter package is ready and downloadable.
- If packaging fails after TTS succeeds, do not charge unless package eventually becomes ready.

### Ask

States:

- `REQUESTED`
- `STT_DONE`
- `ANSWER_DONE`
- `TTS_DONE`
- `DELIVERED`
- `FAILED`
- `CANCELED`

Accounting lifecycle:

1. Create an internal ask usage record when the request starts.
2. Record STT seconds, tokens, web search calls, and answer TTS seconds as they occur.
3. If the request fails before delivering a usable answer, mark usage as canceled.
4. If delivered, commit `ask_count=1` and internal cost dimensions.
5. Apply fair-use policy asynchronously or at request time depending on tier.

Ask should not decrement the user's AI audio minutes by default unless product decides spoken answers are part of that pool. If spoken answers are expensive, track them internally and apply fair-use degradation.

## Fair Use Policy

Implement fair use as a policy layer.

Inputs:

- plan tier
- ask count in current period
- ask cost score in current period
- recent abuse indicators
- current server load

Possible actions:

- full quality answer
- shorter answer
- text-only answer
- no web search
- reduced context window
- temporary cooldown

Recommended V1 behavior:

- Free users: text-first, short answers, limited web search, limited voice answers.
- Starter users: normal answers, occasional web search, voice answers allowed.
- Pro users: voice answers and web search prioritized within reasonable use.
- Heavy users: higher thresholds.

Do not hard fail normal users immediately when an Ask threshold is reached. Prefer graceful degradation.

## APIs

### Get Entitlements

```http
GET /v1/me/entitlements
```

Response:

```json
{
  "planId": "pro",
  "planStatus": "active",
  "periodEndsAt": "2026-05-27T00:00:00Z",
  "aiAudioSecondsRemaining": 18000,
  "aiAudioSecondsUsed": 3600,
  "cloudStorageBytesUsed": 1073741824,
  "cloudStorageBytesLimit": 10737418240,
  "askTier": "pro"
}
```

### Estimate Import Cost

```http
POST /v1/billing/estimate-import
```

Request:

```json
{
  "bookId": "book_...",
  "chapters": [
    {
      "chapterId": "chapter_...",
      "estimatedTextChars": 12000
    }
  ]
}
```

Response:

```json
{
  "estimatedAiAudioSeconds": 1200,
  "hasEnoughCredits": true,
  "warning": null
}
```

### Commit Audio Usage

Internal API or service method only. Do not expose this directly to clients.

Input:

- `userId`
- `bookId`
- `chapterId`
- `operationId`
- `actualAudioSeconds`
- `idempotencyKey`

Behavior:

- idempotent
- ledger-backed
- fails closed if insufficient credits at commit time

### Record Ask Usage

Internal API or service method.

Input:

- `userId`
- `operationId`
- `askCount`
- `costDimensions`
- `delivered`

Behavior:

- records internal usage
- applies fair-use policy
- does not surface hard quota unless policy says to degrade

## Android Requirements

V1 UI should show:

- plan name
- AI audio minutes remaining
- cloud storage used
- upgrade entry point

V1 UI should not emphasize:

- exact Ask remaining count
- token counts
- model prices

Import confirmation should show:

- estimated generated audio minutes
- whether enough AI audio minutes remain
- note that failed generation will not consume credits

When credits are insufficient:

- allow preview/discovery
- block paid generation
- offer upgrade or add-on

When storage is insufficient:

- allow local-only mode if supported
- offer cleanup or upgrade

## Backend Requirements

- Add plan and entitlement service.
- Add credit ledger.
- Add idempotent commit for generated audio.
- Add storage usage tracking.
- Add ask fair-use accounting.
- Integrate chapter import success path with usage commit.
- Integrate failed import path with pending usage cancellation.
- Ensure retries never double charge.

## Migration

Existing users:

- default to `free`
- grant first-month credits if they have no prior credit period
- mark existing locally generated books as local-only unless cloud objects exist
- do not retroactively charge existing generated content

Existing generated cloud content:

- count against cloud storage once storage accounting is introduced
- do not charge AI audio credits retroactively

## Tests

Backend unit tests:

- plan entitlement calculation
- free first-month grant
- monthly credit reset
- add-on consumption after period credits
- idempotent audio usage commit
- retry success charged once
- retry exhaustion not charged
- packaging failure not charged
- storage usage calculation
- ask delivered committed
- ask failure canceled
- fair-use degradation rules

Integration tests:

- import chapter success consumes actual generated seconds
- import failure consumes zero
- automatic retries consume once only on final success
- insufficient credits block generation but allow discovery
- storage quota exceeded blocks cloud persistence or triggers local-only behavior

Android tests where practical:

- entitlement rendering
- import estimate display
- insufficient credit state
- storage warning state

## Rollout Plan

Phase 1:

- Backend-only ledger and entitlement model.
- No payment provider yet.
- Manual seeded plans and test users.

Phase 2:

- Integrate import pipeline with AI audio minute commits.
- Add estimate endpoint.
- Add Android entitlement display.

Phase 3:

- Add cloud storage accounting.
- Add storage warnings and upgrade prompts.

Phase 4:

- Add Ask fair-use accounting and graceful degradation.

Phase 5:

- Integrate payment provider and subscription lifecycle.

## Open Questions

- Which payment provider will be used for China and international users?
- Should spoken Ask answers consume AI audio minutes or remain part of fair use?
- Should add-on AI audio minutes expire?
- Should unused monthly AI audio minutes roll over?
- Should free users get first-month credits once per device, account, or payment identity?
- Should cloud storage support local-only fallback when quota is exceeded?

