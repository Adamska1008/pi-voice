# Pi Voice

Local speech-to-text for Pi.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

Project development notes: [bug fix history](docs/bug-history/README.md).

## Install

Install the npm package:

```bash
pi install npm:@earendil-works/pi-voice
```

If you prefer being on the development tip, you can install from GitHub:

```bash
pi install ssh://git@github.com/earendil-works/pi-voice
```

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Alt+Z` by default) to start and stop recording;
- `/voice`, which does the same as the shortcut. While recording, `Space` also stops and transcribes, and `Escape` discards;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings;
- `/voice-handsfree on|off|status` for opt-in local wake-word dictation. Say **你好问问**, dictate a draft, then separately say **确认发送**. Nothing sends merely because you pause. See [hands-free setup and safety boundaries](docs/handsfree.md).

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

## Upgrading from pi-transcribe

It's recommended to install Pi Voice via NPM. If you have an older install of pi-transcribe uninstall it via: 

```bash
pi remove git:github.com/earendil-works/pi-transcribe
```

If you installed it into a project with `-l`, run `pi remove -l git:github.com/earendil-works/pi-transcribe` from that project instead. Then install Pi Voice with:

```bash
pi install npm:@earendil-works/pi-voice
```

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 512 MiB (about 2.3 hours). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Voice at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in the interactive TUI to choose and, after confirmation, download a local model.

## Project vocabulary

Add `.pi/voice-vocabulary.json` in Pi's current working directory. `/voice` reads
it before each recording; edits apply to the next recording. All chunks and
fallback decoding use the same snapshot. `transcribe_file` does not use it.
Terms are passed to models supporting vocabulary (including Qwen3-ASR); other
models ignore them with a log warning. Terms are hints, not guaranteed spellings.

```json
{"terms": ["Meilisearch", "Dolt", "LanceDB"]}
```

It trims entries, removes empty entries and exact duplicates, and preserves case
and order. Each read returns a fresh snapshot. Missing files mean no manual vocabulary;
invalid or unreadable files return an empty list and a warning for the caller.
The MVP limits are 128 distinct terms and 4096 UTF-16 code units across terms
after normalization; oversized lists are rejected, not silently truncated.
These are application limits, not model token budgets.

Background extraction now sends filtered recent conversation to Pi's selected text model after the agent settles.
On newer Pi versions it uses the model registry to normalize system instructions and resolve authentication;
older Pi versions retain the legacy provider path.
It runs initially, then after two new user turns, with a 30-second cooldown, input deduplication and one request at a time.
This is an additional model request and may consume quota. Input is capped at 1024 UTF-8 bytes (not tokens); output at 512 tokens.
Automatic conversation terms use a 128-entry LRU; up to 64 are extracted per request and up to 64 are offered to each recording, newest mentions first.
Recency follows actual message positions, not extraction time. Known terms refresh after a settled reply without an extra model call.
Repeated scans do not make old terms recent; code blocks, tool output and failed replies do not refresh terms. Empty extraction preserves the cache.
Changes save a versioned `pi-voice-vocabulary` custom entry in Pi's session storage, containing terms and source message IDs only.
Resume, `/reload` and branch navigation restore the latest checkpoint on that branch, preserving recency without a model call.
These entries are excluded from model context. New sessions start empty; non-persistent Pi sessions retain memory-only behavior.
Session/branch changes abort pending work. Manual terms remain independent of automatic eviction; the project vocabulary file is never overwritten.
Before recording, `/voice` merges the latest completed automatic terms with the manual vocabulary, without waiting for extraction.
Manual terms keep priority and order; exact duplicates are removed and automatic terms only fill remaining capacity (128 terms / 4096 UTF-16 units).
The merged snapshot stays fixed across all chunks and fallback decoding; later extraction results apply to the next recording.
Missing or invalid manual files still permit automatic terms; invalid files retain their warning. File transcription remains unaffected.
Dictation also snapshots recent user/assistant prose from the current branch when recording starts (last 80 session entries).
Models supporting `context_prompt` receive it alongside vocabulary; code blocks, tool output, thinking and failed replies are excluded.
The loaded ASR model's tokenizer bounds the reference prompt to 1024 tokens, separately from vocabulary and model formatting overhead.
One prepared prompt is reused for every chunk, native stream and fallback in that recording. Unsupported models omit it; file jobs receive none.
Reload Pi with `/reload` to activate these handlers. No extraction results or conversation text are written to the repository.
Diagnostics are enabled at info level in `~/.pi/agent/pi-voice.log`: extraction decisions/results/failure categories,
checkpoint counts, manual/automatic vocabulary counts, and ASR-applied vocabulary counts and context token counts.
They omit terms, conversation text, model responses and credentials. ASR input logs show parameters passed, not their effect on recognition.

## Developing & Building Pi Voice

To develop or run it from a checkout:

```bash
git clone git@github.com:earendil-works/pi-voice.git
cd pi-voice
npm install --ignore-scripts
pi -e .
```

If you want to be able to re-run onboarding you can enable the debug env var when starting Pi. This enables the `/voice-onboarding` command.

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-voice
```
