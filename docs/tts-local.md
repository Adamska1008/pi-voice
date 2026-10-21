# Local TTS (experimental, not wired to UI)

`SpeechBackend.synthesize` takes text, an optional voice and an AbortSignal; returns complete WAV bytes. Playback is separate.
`QwenSpeechBackend` invokes a local `qwentts.cpp` CLI: configure `executable`, `talkerPath`, `codecPath`, optional `device` and `timeoutMs`. No downloads or installation occur automatically.

Default: Vulkan0, Chinese, Vivian, PCM16 WAV. CUDA0 or CPU can be selected when supported by the executable. Device names are local enumeration identifiers: verify they refer to the intended GPU.
Validated upstream: ServeurpersoCom/qwentts.cpp commit `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4`, 0.6B CustomVoice Q8_0 plus matching 12Hz Q8_0 codec. Windows RTX 3070 Vulkan and CUDA CLI synthesis both worked; this does not establish support for every GPU or future CLI version.

Place required runtime libraries beside the executable or on PATH. The former Python worker prototype has been removed; PyTorch/CUDA Python packages are not required by this backend.
Each request starts a disposable process and reloads models. Text goes through UTF-8 stdin without a shell; stdout contains WAV audio, stderr is excluded. Resident models and automatic replies are not implemented.

`SpeechPlayer` separately streams complete WAV bytes to `ffplay` (`executable` override supported). FFplay must be installed separately and available on PATH; having FFmpeg alone does not guarantee FFplay is present. No temporary audio files are created. Only one playback is allowed at a time; `stop()` waits for the child to close, and caller cancellation is supported. Manual trigger: `/voice-reply` or Ctrl+Alt+X; repeat to cancel. No automatic replies. Starting microphone capture drains speech playback first; branch switches and shutdown cancel pending replies.

Before starting Pi, set `PI_VOICE_TTS_EXECUTABLE` to the local qwen-tts executable, `PI_VOICE_TTS_TALKER` and `PI_VOICE_TTS_CODEC` to the matching GGUF files. Optional: `PI_VOICE_TTS_DEVICE` (default Vulkan0), `PI_VOICE_FFPLAY_PATH` (default ffplay), `PI_VOICE_REPLY_SHORTCUT` (default ctrl+alt+x). These are personal environment settings, not project paths. Changing the parent shell environment requires restarting Pi. Shortcut normalization reuses the recording shortcut rules; an invalid binding or a collision with the recording binding disables only the reply shortcut, not the command.
Limits: 600 input characters, 600 generated frames, 120-second process timeout, 32 MiB returned audio. Cancellation terminates the process. Audio is returned in memory, not written to the project.
