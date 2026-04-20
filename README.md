# Nova

Android audiobook MVP for public web articles.

## Structure

- `backend/`: Node.js + TypeScript service for extraction, TTS, packaging, and job APIs
- `android/`: Native Android app built with Kotlin, Compose, Room, WorkManager, and Media3

## Backend quick start

```bash
cd /Users/xiaoke/Nova/backend
npm install
npm run dev
```

The backend defaults to `mock` TTS mode when `OPENAI_API_KEY` is not set, so the full job flow can be exercised locally without external credentials.

When `OPENAI_API_KEY` is present, the backend also enables an article-cleaning preprocessing step before chaptering. This uses `OPENAI_PREPROCESS_MODEL` (default `gpt-4o-mini`) to drop navigation, share prompts, table-of-contents blocks, and other webpage UI chrome that should not be read aloud.

Batch imports are supported in the Android UI by pasting a block of text or a clipboard dump that contains multiple URLs. The backend runs import jobs with bounded parallelism; tune this with `IMPORT_CONCURRENCY` if you want more or fewer simultaneous conversions.

## Android quick start

The Android project is scaffolded and wired for:

- URL import
- job polling and package download
- local Room persistence
- Media3 background playback
- sentence-level subtitle highlighting

The Android toolchain is installed on this machine. You can build and install with:

```bash
cd /Users/xiaoke/Nova/android
./gradlew installDebug
adb shell am start -n com.xiaoke.nova/com.xiaoke.nova.ui.MainActivity
```
