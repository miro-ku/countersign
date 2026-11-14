import { readFileSync } from 'node:fs';
import { transcribeTurn } from '../../voice/src/speech.ts';
const key = process.env.ELEVENLABS_API_KEY!;
const terms = ['Acme', 'Acme Corp', 'Globex', 'Northwind'];
for (const [name, model, iso, kt] of [['noisy', 'scribe_v2', 'off', terms], ['noisy', 'scribe_v2', 'on', terms], ['noisy', 'scribe_v3', 'off', terms], ['noisy', 'scribe_v3', 'on', terms]] as const) {
  process.env.VOICE_STT_MODEL = model; process.env.VOICE_ISOLATION = iso;
  try { const r = await transcribeTurn(key, readFileSync(`/tmp/cs-shots/${name}.pcm`), [...kt]); console.log(`${name} ${model} isolation=${iso} keyterms=${kt.length} ${r.ms}ms: ${r.text}`); }
  catch (e: any) { console.log(`${name} ${model} iso=${iso} FAILED ${e.message}`); }
}
