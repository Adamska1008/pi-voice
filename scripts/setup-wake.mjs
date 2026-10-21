// Explicit opt-in download; never run by extension startup or microphone capture.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const name = 'sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01';
const expected = 'b2f7c89690dc8ce4c6ed6afeab7cd800c36ad1421fb6b6302b4a4b194cf7f35f';
const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
const destination = resolve(process.env.PI_VOICE_KWS_MODEL_DIR || join(agent, 'models', 'pi-voice-kws'));
if (await stat(destination).catch(() => undefined)) {
  console.log(`Already exists; not overwriting: ${destination}`);
  process.exit(0);
}
const parent = resolve(destination, '..');
await mkdir(parent, { recursive: true });
const temporary = await mkdtemp(join(parent, '.kws-setup-'));
try {
  let bytes;
  if (process.argv[2]) bytes = await readFile(resolve(process.argv[2]));
  else {
    console.log('Downloading local wake model (~32 MiB) from the official sherpa-onnx release…');
    const response = await fetch(`https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${name}.tar.bz2`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 45 * 1024 * 1024) throw new Error('Model archive exceeds size limit');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Wake model archive SHA256 mismatch');
  const archive = join(temporary, 'model.tar.bz2');
  await writeFile(archive, bytes);
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const extraction = spawnSync(tar, ['-xjf', archive, '-C', temporary], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
  if (extraction.error || extraction.status !== 0) throw new Error('Could not extract model: install a tar command supporting bzip2.');
  const selected = join(temporary, 'selected');
  await mkdir(selected);
  for (const file of ['encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx', 'decoder-epoch-99-avg-1-chunk-16-left-64.onnx', 'joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx', 'tokens.txt']) {
    await copyFile(join(temporary, name, file), join(selected, file));
  }
  await rename(selected, destination);
  console.log(`Local wake model ready: ${destination}\nWake phrase: 你好问问. Enable explicitly with /voice-handsfree on.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
