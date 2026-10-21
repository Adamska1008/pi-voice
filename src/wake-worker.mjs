// Native KWS is isolated: malformed models/native failures must not take down Pi.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let spotter;
let stream;
process.on('message', message => {
  try {
    if (message.type === 'init') {
      const { KeywordSpotter } = require('sherpa-onnx-node');
      spotter = new KeywordSpotter({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { transducer: message.models, tokens: message.tokens, numThreads: 1, provider: 'cpu', debug: 0 },
        keywordsFile: message.keywords,
      });
      stream = spotter.createStream();
    } else if (message.type === 'reset') {
      stream = spotter.createStream(); // Discard old acoustic context as well as search hypotheses.
    } else if (message.type === 'audio') {
      stream.acceptWaveform({ samples: message.samples, sampleRate: 16000 });
      let keyword = '';
      while (spotter.isReady(stream)) {
        spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (result.keyword) { keyword = result.keyword; spotter.reset(stream); }
      }
      process.send?.({ id: message.id, keyword });
      return;
    } else throw new Error('Unknown KWS operation');
    process.send?.({ id: message.id });
  } catch {
    process.send?.({ id: message.id, error: 'Local wake-word inference failed; check the KWS model files.' });
  }
});
process.on('disconnect', () => process.exit(0));
