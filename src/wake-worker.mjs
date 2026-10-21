// Native KWS is isolated: malformed models/native failures must not take down Pi.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let spotter;
let stream;
let frames = 0;
let recent = [];
function freshStream() {
  stream = spotter.createStream();
  frames = 0;
  global.gc?.(); // Release native stream handles even when JS heap pressure is low.
}
function feed(samples) {
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  let keyword = '';
  while (spotter.isReady(stream)) {
    spotter.decode(stream);
    const result = spotter.getResult(stream);
    if (result.keyword) { keyword = result.keyword; spotter.reset(stream); }
  }
  return keyword;
}
process.on('message', message => {
  try {
    if (message.type === 'init') {
      const { KeywordSpotter } = require('sherpa-onnx-node');
      spotter = new KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { transducer: message.models, tokens: message.tokens, numThreads: 1, provider: 'cpu', debug: 0 },
        keywordsFile: message.keywords,
      });
      freshStream();
    } else if (message.type === 'reset') {
      recent = [];
      freshStream(); // Discard previous utterance acoustic context too.
    } else if (message.type === 'audio') {
      let keyword = '';
      if (frames >= 1875) { // One minute of audio; replay three seconds across the window boundary.
        freshStream();
        for (const frame of recent) keyword = feed(frame) || keyword;
      }
      keyword = feed(message.samples) || keyword;
      frames++;
      recent.push(message.samples);
      if (recent.length > 94) recent.shift();
      process.send?.({ id: message.id, keyword });
      return;
    } else throw new Error('Unknown KWS operation');
    process.send?.({ id: message.id });
  } catch {
    process.send?.({ id: message.id, error: 'Local wake-word inference failed; check the KWS model files.' });
  }
});
process.on('disconnect', () => process.exit(0));
