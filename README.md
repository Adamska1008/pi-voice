# Pi Voice

Local speech-to-text for Pi.

Press a keyboard shortcut, talk, and the resulting transcript will be put directly into your chat.

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
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

### Automatic language identification

Multilingual models that require a language hint can also use **Auto detect**.
Their download includes a shared VoxLingua107 language-identification model
(about 27 MB), with the additional size shown before downloading. Once cached,
that companion is reused by other models. Models with native detection are
unchanged; single-language models do not need the companion.

External detection chooses among your preferred languages supported by the
transcription model. With only one compatible preferred language, Pi Voice uses
it directly. With multiple, every candidate must be supported by the detector.
Cantonese and Irish are not detector labels: select an explicit transcription
language or a different model for combinations that include them. Mandarin is
not treated as an alias for Cantonese.

Detection runs on the first seven seconds of each recording or file once it
ends; the detector loads while you speak. One language is used
for the entire take (and for each file). The detector's top pick among your
preferred languages is always used; it carries a warning when it is less than
1.5x as likely as the runner-up, and every decision is logged. Only a detector
failure falls back to the first compatible preferred language. Clips under
500 ms skip detection. There is no padding, silence filtering, or voice activity detection in this version,
and silence can still receive a prediction.
Transcription never downloads a model: if the detector is missing, choose the
model again in `/voice-settings` to download it.

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

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 128 MiB (about 35 minutes). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

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
