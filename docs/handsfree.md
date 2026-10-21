# Experimental local hands-free input

This is opt-in, session-only, and never starts listening when Pi launches. Use an interactive terminal. There is no voice authentication: anyone nearby, a TV or other audio can trigger recognition. Do not enable it for unattended/high-risk work.

## Setup

Install package dependencies normally, then explicitly download the small Chinese keyword model:

```sh
npm run wake:setup
```

The setup command downloads the pinned ~32 MiB official sherpa-onnx archive, verifies SHA256 and extracts selected models with `tar`. Windows uses the built-in System32 tar. It needs no Python, CUDA or administrator permissions. Existing destination directories are not overwritten. The default destination is `<Pi agent dir>/models/pi-voice-kws`; `PI_VOICE_KWS_MODEL_DIR` overrides it. Setup honors `PI_CODING_AGENT_DIR`. An optional local archive argument avoids another download (same SHA256 check).

ASR and the microphone must already be configured through `/voice-settings`. No keyword models are downloaded during extension startup or recording. Sherpa-ONNX 1.13.8 runs the wake model on CPU in an isolated native worker; ordinary speech transcription reuses the configured local ASR model. Acoustic streams roll every minute; the native process recycles after five minutes of processed listening audio, retaining three seconds of overlap across boundaries to bound native memory lifetime. `models/wake-keywords.txt` contains the sole enabled phrase, **你好问问**. Other sample-model keywords are not enabled.

## Interaction

1. Empty the editor; run `/voice-handsfree on` (or `/voice-handsfree` to toggle). Confirm continuous microphone access.
2. Watch the status line: say **你好问问**, wait for the terminal cue and a short ~0.7 second guard, then dictate. If terminal bells are muted, use the visible state indication.
3. About one second of silence ends the utterance and transcribes a **draft**, not a submission.
4. In the draft confirmation state, say a separate utterance:
   - **确认发送** — submit exactly that draft to the configured assistant.
   - **取消输入** — clear the owned draft and return to wake listening.
   - **继续** or **继续输入** — dictate another paragraph to append.
5. `/voice-handsfree off` closes the microphone; `/voice-handsfree status` reports the state.

Only exact normalized commands in the confirmation state take effect. For example, “请帮我写一个发送邮件的函数” is ordinary dictation; “发送”, “请确认发送” and “不要确认发送” do not submit. Unknown commands leave the draft unchanged. Speech recognition can still make mistakes; exact matching reduces, but cannot eliminate, accidental submission risk.

## Boundaries and cleanup

- Assistant activity and manual spoken replies pause recognition; after they finish, a fresh wake phrase is required. A retained draft re-enters confirmation rather than being silently submitted.
- Waiting without speech times out to wake listening after about 20 seconds. The editor draft is retained. Dictation/command utterances are capped at 60/8 seconds; overlong utterances stop the mode without sending.
- Starting manual recording or opening voice settings stops hands-free mode first. Branch switches, shutdown and reload stop it too; it never automatically re-enables.
- Editing the owned draft by keyboard stops the mode rather than overwriting or submitting the altered editor. Use ordinary editor submission afterward. This first version supports text-only drafts, not image/attachment workflows.
- The recorder uses `collect:false`. Idle/busy audio is discarded, buffered audio is bounded, and nothing is written to disk. Only an explicit confirmed draft is sent to the assistant provider; the local wake/ASR pipeline makes no model API requests.
- Wake worker failure, queue overflow, microphone failure or a 30-second ASR timeout stops the mode. Uncertain/failed recognition does not send anything. A paused mic remains open but its incoming audio is discarded; use `off` to release it completely.

## Validation and known limits

Automated tests cover state boundaries, command matching, cancellation, stale approvals, editor preservation, resource cleanup, consent, and non-collecting capture. On the development Windows machine, synthetic Chinese audio successfully traversed real local KWS → Silero VAD → ASR → draft → exact confirmation → one intercepted test submission; repeated confirmation without a wake did not submit. No real assistant request or live microphone capture was used in that test. A separate 20-minute synthetic-silence input was processed faster than real time with zero detections; periodic native-process recycling was observed, with sampled worker memory approximately 102–130 MiB. This is a resource check, not a real-room false-wake benchmark.

Real-room false-wake rates, accents, microphone quality, muted terminal cues, sustained background audio and other platforms remain user-validation work. This is not speaker verification or a substitute for reviewing dangerous assistant actions. Default Chinese wake-word selection is deliberately fixed for this first version; tuning/model replacement is a separate task.
