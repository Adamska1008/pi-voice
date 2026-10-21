# Local TTS (experimental, not wired to UI)

`SpeechBackend.synthesize` takes text, an optional voice and an AbortSignal; returns complete WAV bytes. Playback is separate.
`QwenSpeechBackend` invokes a local `qwentts.cpp` CLI: configure `executable`, `talkerPath`, `codecPath`, optional `device` and `timeoutMs`. No downloads or installation occur automatically.

Default: Vulkan0, Chinese, Vivian, PCM16 WAV. CUDA0 or CPU can be selected when supported by the executable. Device names are local enumeration identifiers: verify they refer to the intended GPU.
Validated upstream: ServeurpersoCom/qwentts.cpp commit `5916bf7c79dbb4e66fc059cdc507a79a23a28bb4`, 0.6B CustomVoice Q8_0 plus matching 12Hz Q8_0 codec. Windows RTX 3070 Vulkan and CUDA CLI synthesis both worked; this does not establish support for every GPU or future CLI version.

Place required runtime libraries beside the executable or on PATH. The former Python worker prototype has been removed; PyTorch/CUDA Python packages are not required by this backend.
Each request starts a disposable process and reloads models. Text goes through UTF-8 stdin without a shell; stdout contains WAV audio, stderr is excluded. Resident models and automatic replies are not implemented.

`SpeechPlayer` separately streams complete WAV bytes to `ffplay` (`executable` override supported). FFplay must be installed separately and available on PATH; having FFmpeg alone does not guarantee FFplay is present. No temporary audio files are created. Only one playback is allowed at a time; `stop()` waits for the child to close, and caller cancellation is supported. Neither playback nor TTS is wired to shortcuts yet.
Limits: 600 input characters, 600 generated frames, 120-second process timeout, 32 MiB returned audio. Cancellation terminates the process. Audio is returned in memory, not written to the project.
