# Voice-First Interaction PRD

## Purpose

The product direction is shifting from "a mobile audiobook player with AI Q&A" to "a voice-first learning assistant that minimizes phone usage."

The app should help Chinese users consume long-form knowledge without looking at the screen. The primary competition is not generic TTS apps. The strategic target is to outperform Ximalaya-style audio platforms and WeChat Reading-style reading apps by turning user-owned long content into an eyes-free, askable, replayable, reviewable learning experience.

This document is intended for coding agents. Implement in phases and keep each phase independently testable. Do not rename the codebase or app brand in this milestone unless explicitly requested.

## Product Positioning

### Core Promise

Users should be able to keep learning while walking, commuting, doing housework, resting at night, or protecting their eyes.

The app should not train users to constantly open the phone. Every major learning action should have a voice-first path:

- continue listening
- pause
- replay what was just explained
- ask a question
- move to the next or previous semantic segment
- switch chapters
- switch books
- summarize
- save and replay audio review notes
- start a sleep timer

### Differentiation

- Against Ximalaya: user-imported knowledge, AI understanding, contextual Q&A, semantic replay, not a passive content platform.
- Against WeChat Reading: eyes-free learning, headset interaction, audio-first review, not screen-first reading and note taking.
- Against generic TTS: the app adapts text into listenable scripts, understands the current context, and can answer or replay semantically.

## Non-Negotiable UX Principles

### Phone-Minimization Principle

The app must avoid features that require users to frequently look at the screen during listening.

Rules:

- Do not make timestamps the primary answer format.
- Do not encourage users to tap a transcript to continue learning.
- Do not make summaries or notes text-first.
- Do not require opening the app for common playback commands.
- Do not require opening the app to confirm a book switch if voice confirmation is reliable.

### Audio-First Evidence Principle

For Q&A answers, the assistant may include short evidence, but evidence must be voice-friendly.

Allowed:

- short original quote
- semantic locator such as "in the section about user journey map"
- chapter title or nearby heading
- brief explanation of why the quoted text supports the answer

Avoid:

- clickable timestamps as the main affordance
- long original quotations
- long source lists read aloud
- requiring the user to open the screen to inspect citations

### Audio-First Review Principle

Summaries and study notes should be generated as replayable audio objects first.

Text artifacts may exist internally for search, indexing, subtitles, or optional reading, but the primary user-facing review experience should be:

- short recap audio
- chapter review audio
- daily review audio
- "things you asked about" audio
- "things you did not understand" audio

## Interaction Trigger

### Primary Trigger

When an audiobook is playing, a headset pause/play media button should be treated as the interaction key.

Expected behavior:

1. User presses headset pause/play.
2. App pauses current playback.
3. App starts a short listening window for a command.
4. User speaks a command or asks a question.
5. App classifies the intent.
6. App performs the command or answers in audio.
7. App either resumes playback, stays paused, or navigates depending on the command.

### UI Pause Must Remain Normal Pause

Tapping the in-app pause button should remain a normal pause action. It should not automatically enter voice-command mode unless the user taps a dedicated voice-command button.

### Fallback Trigger

For emulator testing and users without supported headset media buttons, keep a debug text-command entry point in debug builds.

## Command Taxonomy

### A. Contextual Learning Commands

These commands require semantic context around the current playback position.

Supported intents:

- `ASK_CONTEXTUAL_QUESTION`
- `REPLAY_PREVIOUS_SEMANTIC_UNIT`
- `EXPLAIN_CURRENT_SEGMENT`
- `SUMMARIZE_CURRENT_SEGMENT`
- `SUMMARIZE_CURRENT_CHAPTER`
- `SAVE_CURRENT_INSIGHT`
- `CREATE_AUDIO_REVIEW`

Examples:

- "刚才那段我没听懂，重新讲一遍。"
- "这段是什么意思？"
- "用更简单的话解释一下。"
- "这个和产品经理有什么关系？"
- "把这一章总结成三分钟复习音频。"
- "把刚才这个问题保存到复习里。"

### B. Semantic Navigation Commands

These commands navigate by meaning, not fixed seconds.

Supported intents:

- `NEXT_SEGMENT`
- `PREVIOUS_SEGMENT`
- `REPEAT_CURRENT_SEGMENT`
- `NEXT_SECTION`
- `PREVIOUS_SECTION`
- `NEXT_CHAPTER`
- `PREVIOUS_CHAPTER`
- `START_CHAPTER_OVER`
- `CONTINUE_FROM_LAST_POSITION`

Examples:

- "下一段。"
- "上一段。"
- "这一段再听一遍。"
- "下一章。"
- "回到本章开头。"
- "继续上次听的地方。"

Rules:

- Segment-level navigation should use `script.json` semantic segment boundaries.
- Chapter-level navigation should use `Book -> Chapter` order.
- If a target chapter is not ready, speak a short waiting response and either continue current chapter or pause based on command context.

### C. Standard Playback Commands

These commands map to normal media-player behavior.

Supported intents:

- `PLAY`
- `PAUSE`
- `STOP`
- `SEEK_FORWARD`
- `SEEK_BACKWARD`
- `SET_SPEED`
- `GET_PROGRESS`

Examples:

- "暂停。"
- "继续播放。"
- "快进十五秒。"
- "后退半分钟。"
- "调到一点五倍速。"
- "现在听到哪了？"

Rules:

- These commands should be deterministic and should not require LLM reasoning when simple regex or command grammar can resolve them.
- `SEEK_FORWARD` and `SEEK_BACKWARD` remain fixed-time commands and are allowed as explicit user commands.
- Semantic replay should remain the default for vague commands like "刚才那段".

### D. Loop Mode Commands

Supported intents:

- `LOOP_OFF`
- `LOOP_SEGMENT`
- `LOOP_CHAPTER`
- `LOOP_BOOK`
- `LOOP_QUEUE`

Chinese user-facing names:

- no loop: "关闭循环"
- segment loop: "这一段循环"
- chapter loop: "单章循环"
- book loop: "整本循环"
- queue loop: "列表循环"

Examples:

- "这一段循环播放。"
- "单曲循环。" Treat as chapter loop in audiobook context.
- "列表循环。"
- "关闭循环。"

Rules:

- In audiobook context, "单曲循环" maps to current chapter loop unless the current content is a standalone single-article book.
- Segment loop should use semantic segment boundaries.
- Loop state must persist for the current playback session. Later product decision can decide whether to persist across app restarts.

### E. Sleep Timer Commands

Supported intents:

- `SET_SLEEP_TIMER_MINUTES`
- `SET_SLEEP_TIMER_AFTER_SEGMENT`
- `SET_SLEEP_TIMER_AFTER_CHAPTER`
- `CANCEL_SLEEP_TIMER`
- `GET_SLEEP_TIMER`

Examples:

- "十五分钟后关闭。"
- "听完这一章就停。"
- "听完这一段就停。"
- "取消定时关闭。"
- "还有多久关闭？"

Rules:

- Timer state must be visible in the player UI but should be fully controllable by voice.
- When timer expires, pause playback and speak no long message. A short optional cue is acceptable.

### F. Switch Book Commands

Supported intents:

- `SWITCH_BOOK_REQUEST`
- `SWITCH_BOOK_CONFIRM`
- `SWITCH_BOOK_CANCEL`

Examples:

- "换到《用户旅程地图》。"
- "打开上次那本书。"
- "换一本产品经理相关的。"
- "确认。"
- "不要，继续现在这本。"

Flow:

1. User says a book-switch request.
2. App searches local library by title, aliases, source title, and recent books.
3. If there is one high-confidence match, app speaks: "找到《X》，要切换过去吗？"
4. User says "确认" or "取消".
5. On confirm, app opens the matched book at its saved position and starts playback.
6. If multiple matches exist, app speaks up to three options and asks the user to choose by spoken title or ordinal.

Rules:

- Do not switch books without confirmation unless the command is unambiguous and user settings allow fast switching.
- Do not require screen confirmation for normal book switching.
- If confidence is low, ask the user to repeat the book name rather than showing a visual picker.

## Intent Resolution Architecture

Use a two-stage approach.

### Stage 1: Deterministic Command Parser

Handle low-cost deterministic commands locally or on backend without an LLM:

- play/pause/stop
- next/previous chapter
- next/previous segment
- fixed seek
- speed
- loop mode
- sleep timer
- confirmation/cancel

This improves latency, cost, and reliability.

### Stage 2: LLM Intent Classifier

Use an LLM only when the command needs semantic interpretation:

- contextual Q&A
- vague replay request
- explanation or analogy
- book search with fuzzy title
- summary generation
- ambiguous command disambiguation

The classifier should return a structured action object, not free-form text.

## Backend API Changes

### Extend Voice Command Response

Current endpoint:

```http
POST /v1/voice-commands
```

Extend response:

```json
{
  "intent": "NEXT_CHAPTER",
  "transcript": "下一章",
  "spokenResponse": "好的，播放下一章。",
  "action": {
    "type": "PLAY_CHAPTER",
    "bookId": "book_123",
    "chapterId": "chapter_2",
    "positionMs": 0
  },
  "answerAudioUrl": null,
  "replaySegment": null,
  "requiresConfirmation": false,
  "confirmation": null,
  "errorMessage": null
}
```

### Action Types

Supported `action.type` values:

- `NONE`
- `RESUME`
- `PAUSE`
- `STOP`
- `SEEK_RELATIVE`
- `SET_SPEED`
- `PLAY_SEGMENT`
- `PLAY_CHAPTER`
- `PLAY_BOOK`
- `SET_LOOP_MODE`
- `SET_SLEEP_TIMER`
- `CANCEL_SLEEP_TIMER`
- `PLAY_ANSWER_AUDIO`
- `PLAY_REVIEW_AUDIO`
- `REQUEST_CONFIRMATION`
- `ERROR`

### Confirmation Payload

```json
{
  "id": "confirm_...",
  "kind": "SWITCH_BOOK",
  "spokenPrompt": "找到《用户旅程地图》，要切换过去吗？",
  "expiresAt": "2026-04-27T12:00:00.000Z",
  "candidate": {
    "bookId": "book_123",
    "title": "用户旅程地图"
  }
}
```

The app must keep a short-lived pending confirmation state. The next voice command can confirm or cancel it.

## Android App Changes

### Playback State

Add local playback state for:

- loop mode
- sleep timer
- pending confirmation
- active semantic segment
- current book/chapter resume point

### Playback Commands

The Android app should execute simple playback actions locally after receiving structured intent/action. It should not wait for audio answer generation for commands like next chapter or pause.

### Voice Responses

For command acknowledgements, use the shortest possible spoken response. Long acknowledgements increase friction.

Examples:

- "好的，下一章。"
- "已暂停。"
- "十五分钟后关闭。"
- "已切换到《X》。"

### Audio Review Library

Add a lightweight review concept:

- `ReviewAudio`
- belongs to a book and optional chapter
- generated from summaries, saved insights, or user questions
- playable like a short chapter
- can be included in a daily review queue

V1 can store review audio locally only.

## Data Model Additions

### PlaybackPreference

Fields:

- `id`
- `bookId?`
- `loopMode`: `OFF | SEGMENT | CHAPTER | BOOK | QUEUE`
- `speed`
- `sleepTimerEndsAt?`
- `sleepTimerMode?`: `MINUTES | AFTER_SEGMENT | AFTER_CHAPTER`
- `updatedAt`

### PendingVoiceConfirmation

Fields:

- `id`
- `kind`
- `payloadJson`
- `spokenPrompt`
- `expiresAt`
- `createdAt`

### ReviewAudio

Fields:

- `id`
- `bookId`
- `chapterId?`
- `source`: `SEGMENT_SUMMARY | CHAPTER_SUMMARY | USER_QUESTION | SAVED_INSIGHT | DAILY_REVIEW`
- `title`
- `audioPath`
- `subtitlePath?`
- `durationMs`
- `sourceText?`
- `createdAt`

## Implementation Phases

### Phase 1: Command Intent Expansion

Goal: make the existing voice-command endpoint return structured actions for deterministic playback commands.

Scope:

- Add intent enum values.
- Add deterministic parser for Chinese playback commands.
- Add action response schema.
- Keep existing replay and Q&A behavior.
- Add backend unit tests for command parsing.
- Add Android action executor for pause/resume/seek/speed/next/previous chapter.

Validation:

- Debug text command "下一章" moves to next chapter.
- "暂停" pauses without Q&A.
- "一点五倍速" sets speed.
- Existing "上一段没听懂" still replays semantic segment.

### Phase 2: Loop and Sleep Timer

Goal: support voice-controlled loop modes and sleep timer.

Scope:

- Add loop mode state to playback manager.
- Add semantic segment loop.
- Add chapter/book/queue loop behavior.
- Add sleep timer state and expiration behavior.
- Add UI indicator but keep voice control primary.

Validation:

- "单曲循环" loops current chapter.
- "这一段循环" loops current semantic segment.
- "十五分钟后关闭" pauses after timer expires.
- "听完这一章就停" pauses at chapter end.

### Phase 3: Book Switching by Voice

Goal: switch books without opening the phone.

Scope:

- Add local library search by title and recent books.
- Add pending confirmation model.
- Add confirmation/cancel command handling.
- Add spoken prompts.

Validation:

- "换到《X》" prompts confirmation.
- "确认" switches and resumes saved position.
- Ambiguous match asks for clarification.
- Expired confirmation does not switch accidentally.

### Phase 4: Audio-First Review Notes

Goal: make summaries and saved notes replayable as audio.

Scope:

- Add `ReviewAudio` model.
- Generate short recap audio from current segment/chapter.
- Save user Q&A as review candidates.
- Add "今日复习" or "最近复习" audio queue.

Validation:

- "把这一章总结成三分钟复习音频" creates review audio.
- "播放今天的复习" starts review queue.
- User can consume review without reading text notes.

### Phase 5: Eyes-Free Polish

Goal: reduce phone-opening pressure.

Scope:

- Shorten spoken acknowledgements.
- Remove timestamp-forward language from Q&A answers.
- Add semantic locators and short quotes.
- Add headset-key/manual tests.
- Add accessibility copy in Chinese emphasizing eyes-free and eye-health benefits.

Validation:

- Q&A answers use short quote + semantic locator, not timestamp-first citations.
- Common commands work from headset media button.
- The app remains usable from lock screen for core listening commands.

## Testing Matrix

### Command Parsing

- "暂停"
- "继续"
- "下一段"
- "上一段"
- "下一章"
- "上一章"
- "重播刚才那段"
- "快进十五秒"
- "后退三十秒"
- "一点二五倍速"
- "单曲循环"
- "列表循环"
- "关闭循环"
- "十五分钟后关闭"
- "听完这一章就停"
- "取消定时关闭"
- "换到用户旅程地图"
- "确认"
- "取消"

### Product Behavior

- Commands should work while the app is in foreground.
- Commands should work while the app is backgrounded when media session routing supports it.
- Debug text command should allow emulator testing for all intents.
- UI pause should not accidentally trigger voice command.
- Headset pause/play should enter voice-command mode only when an audiobook is active.
- Failed or ambiguous commands should produce short voice clarification.

### Regression

- Existing URL import still works.
- Existing audiobook playback still works.
- Existing semantic replay still works.
- Existing contextual Q&A still works.
- Existing package download/offline playback still works.

