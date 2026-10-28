#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   NARRA A VSL — o roteiro de `narracao.json` vira voz na ElevenLabs,
   cada bloco entra no segundo certo do vídeo, e o resultado é mixado
   dentro do vsl.mp4 e do vsl.webm.

   USO
     node narra.mjs --seco                 confere o roteiro, não gasta nada
     ELEVENLABS_API_KEY=sk_... node narra.mjs
     ELEVENLABS_API_KEY=sk_... node narra.mjs --so-audio    (não mexe no vídeo)

   ⚠️ O VÍDEO É MUDO. Medido: `vsl.mp4` não tem faixa de áudio nenhuma —
   por isso a narração não precisa de mixagem com trilha, ela É o áudio.

   ⚠️ CADA BLOCO É MEDIDO DEPOIS DE SINTETIZADO. Se a fala passar por cima
   do bloco seguinte, o script AVISA com o número de segundos que sobrou.
   Narração que atropela a cena é pior que narração nenhuma: a pessoa
   ouve "a dose exata" enquanto a tela já está no cronograma.

   ⚠️ CACHE EM `voz/`. Cada bloco vira um mp3 com o nome do seu hash. Rodar
   de novo depois de mexer em UM bloco só paga aquele bloco.
   ══════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROTEIRO = path.join(AQUI, 'narracao.json');
const VOZES = path.join(AQUI, 'voz');
const MP4 = path.join(AQUI, 'assets', 'vsl.mp4');
const WEBM = path.join(AQUI, 'assets', 'vsl.webm');
const SAIDA_WAV = path.join(AQUI, 'voz', 'narracao.wav');

const SECO = process.argv.includes('--seco');
const SO_AUDIO = process.argv.includes('--so-audio');
const CHAVE = process.env.ELEVENLABS_API_KEY || '';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const dur = (f) => Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
  '-of', 'default=nw=1:nk=1', f]).trim());

const r = JSON.parse(readFileSync(ROTEIRO, 'utf8'));
const blocos = r.blocos;
const voz = r._voz;

/* ── 1) a conferência que não custa nada ─────────────────────────────── */
const DUR_VIDEO = existsSync(MP4) ? dur(MP4) : 108.3;
let problemas = 0;
console.log(`\nvídeo: ${DUR_VIDEO.toFixed(1)}s · ${blocos.length} blocos · ${blocos.reduce((s, b) => s + b.texto.length, 0)} caracteres\n`);
blocos.forEach((b, i) => {
  const prox = blocos[i + 1] ? blocos[i + 1].em : DUR_VIDEO;
  const janela = prox - b.em;
  /* ~14,5 caracteres por segundo é o que a voz Jessica faz em pt-BR no
     turbo v2.5 a 1.0 — medido depois, aqui serve só de alerta antecipado */
  const palpite = b.texto.length / 14.5;
  const folga = janela - palpite;
  if (b.em < 0 || prox <= b.em) { console.log(`  ✗ bloco ${i + 1}: tempo fora de ordem`); problemas++; }
  if (/\[[^\]]+\]/.test(b.texto)) { console.log(`  ✗ bloco ${i + 1}: tem COLCHETE — a ElevenLabs fala a palavra`); problemas++; }
  const sinal = folga < 0 ? '✗' : folga < 0.6 ? '!' : '·';
  if (folga < 0.6) problemas += folga < 0 ? 1 : 0;
  console.log(`  ${sinal} ${String(i + 1).padStart(2)}  ${b.em.toFixed(1)}s→${prox.toFixed(1)}s  janela ${janela.toFixed(1)}s  palpite ${palpite.toFixed(1)}s  folga ${folga.toFixed(1)}s   ${b.cena}`);
});
if (SECO) {
  console.log(problemas ? `\n${problemas} problema(s) no roteiro.\n` : '\nRoteiro de pé. Falta a chave da ElevenLabs pra ouvir.\n');
  process.exit(problemas ? 1 : 0);
}

/* ── 2) a voz ────────────────────────────────────────────────────────── */
if (!CHAVE) {
  console.error('\n✗ falta ELEVENLABS_API_KEY.\n  A chave que estava no Mac (jarvis-da-lala/.env) morreu:');
  console.error('  a própria ElevenLabs devolve 401 invalid_api_key pra ela.');
  console.error('  Gere uma nova em elevenlabs.io → Developers → API keys e rode:');
  console.error('    ELEVENLABS_API_KEY=sk_... node narra.mjs\n');
  process.exit(2);
}
if (!existsSync(VOZES)) mkdirSync(VOZES, { recursive: true });

async function falar(texto) {
  const chave = createHash('sha1')
    .update(texto + JSON.stringify(voz.ajuste) + voz.id + voz.modelo).digest('hex').slice(0, 12);
  const arq = path.join(VOZES, chave + '.mp3');
  if (existsSync(arq)) return { arq, cache: true };
  const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voz.id}`, {
    method: 'POST',
    headers: { 'xi-api-key': CHAVE, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: texto, model_id: voz.modelo, voice_settings: voz.ajuste }),
  });
  if (!resp.ok) throw new Error(`ElevenLabs ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  writeFileSync(arq, Buffer.from(await resp.arrayBuffer()));
  return { arq, cache: false };
}

const pecas = [];
for (const [i, b] of blocos.entries()) {
  const { arq, cache } = await falar(b.texto);
  const d = dur(arq);
  pecas.push({ ...b, arq, d });
  console.log(`  ${String(i + 1).padStart(2)}  ${d.toFixed(1)}s  ${cache ? '(cache)' : 'novo  '}  ${b.cena}`);
}

/* ── 3) cada fala no seu segundo ─────────────────────────────────────── */
/* `adelay` por faixa + `amix` deixaria o volume caindo a cada soma; o
   jeito certo é `amix` com `normalize=0`, senão 16 faixas viram sussurro. */
const entradas = pecas.flatMap(p => ['-i', p.arq]);
const filtros = pecas.map((p, i) =>
  `[${i}:a]aresample=44100,adelay=${Math.round(p.em * 1000)}|${Math.round(p.em * 1000)}[a${i}]`).join(';');
const soma = pecas.map((_, i) => `[a${i}]`).join('');
const filtro = `${filtros};${soma}amix=inputs=${pecas.length}:normalize=0:dropout_transition=0[mix];` +
  `[mix]apad,atrim=0:${DUR_VIDEO},alimiter=limit=0.95[out]`;
sh('ffmpeg', ['-v', 'error', ...entradas, '-filter_complex', filtro, '-map', '[out]',
  '-ac', '2', '-ar', '44100', '-y', SAIDA_WAV]);
console.log(`\nnarração montada: ${dur(SAIDA_WAV).toFixed(1)}s  (vídeo ${DUR_VIDEO.toFixed(1)}s)`);

/* ── 4) atropelo: a fala que invade a cena seguinte ──────────────────── */
let atropelos = 0;
pecas.forEach((p, i) => {
  const prox = pecas[i + 1] ? pecas[i + 1].em : DUR_VIDEO;
  const fim = p.em + p.d;
  if (fim > prox + 0.25) {
    console.log(`  ⚠️ bloco ${i + 1} termina em ${fim.toFixed(1)}s e o ${i + 2 <= pecas.length ? 'próximo' : 'vídeo'} começa/acaba em ${prox.toFixed(1)}s — sobra ${(fim - prox).toFixed(1)}s por cima`);
    atropelos++;
  }
});
console.log(atropelos ? `\n${atropelos} bloco(s) atropelando. Encurte o texto e rode de novo (o cache paga só o que mudou).\n`
  : '\nNenhum bloco atropela a cena seguinte.\n');

if (SO_AUDIO) process.exit(atropelos ? 1 : 0);

/* ── 5) a voz entra no vídeo ─────────────────────────────────────────── */
/* ⚠️ `-c:v copy` de propósito: re-encodar o vídeo de novo só pra colar
   áudio perderia qualidade uma segunda vez sem motivo nenhum. */
for (const [arq, codec] of [[MP4, 'aac'], [WEBM, 'libopus']]) {
  if (!existsSync(arq)) continue;
  const tmp = arq + '.tmp' + path.extname(arq);
  sh('ffmpeg', ['-v', 'error', '-i', arq, '-i', SAIDA_WAV, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', codec, '-b:a', '128k', '-shortest', '-movflags', '+faststart', '-y', tmp]);
  rmSync(arq); sh('mv', [tmp, arq]);
  console.log(`  ✅ ${path.basename(arq)} agora tem voz`);
}
console.log('');
