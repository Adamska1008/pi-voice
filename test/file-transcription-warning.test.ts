import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerFileTranscriptionTool } from "../src/file-transcription.js";
import { settingsForModel } from "../src/settings.js";
import type { TranscriptionService } from "../src/transcription-service.js";

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

function wav(): Buffer {
  const samples = 16000;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}

for (const transcript of ["hello", ""]) {
  test(`file transcription keeps language warning in details and tool output (${transcript ? "text" : "empty"})`, { skip: !ffmpegAvailable }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-voice-file-warning-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const previous = process.env.PI_VOICE_FFMPEG_PATH;
    process.env.PI_VOICE_FFMPEG_PATH = "ffmpeg";
    t.after(() => {
      if (previous === undefined) delete process.env.PI_VOICE_FFMPEG_PATH;
      else process.env.PI_VOICE_FFMPEG_PATH = previous;
    });
    const path = join(directory, "clip.wav");
    await writeFile(path, wav());
    type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];
    let tool!: RegisteredTool;
    const api = { registerTool(definition: RegisteredTool) { tool = definition; } } as ExtensionAPI;
    const warning = "Low confidence; used English.";
    const controller = registerFileTranscriptionTool(api, {
      getSettings: async () => settingsForModel("canary-180m-flash", "/tmp/asr"),
      getService: async () => ({
        async transcribeFile() {
          return { text: transcript, warning };
        },
      }) as unknown as TranscriptionService,
    });
    t.after(() => controller.shutdown());
    const result = await tool.execute("test", { path }, undefined, undefined, { cwd: directory } as ExtensionContext);
    assert.equal((result.details as { warning: string }).warning, warning);
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text, /Language identification warning: Low confidence; used English/);
    if (transcript) assert.ok(text.text.startsWith(transcript));
    else assert.match(text.text, /No speech detected/);
  });
}
