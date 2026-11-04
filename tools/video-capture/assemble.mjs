#!/usr/bin/env node
/**
 * tools/video-capture/assemble.mjs — cut the rendered shots into one video.
 *
 *   node tools/video-capture/assemble.mjs --plan plan.json --dir <render dir> --out final.mp4
 *        [--encoder libx264|h264_amf] [--crf 16] [--preset fast]
 *
 * Reads <dir>/<shot>.mp4 for every shot in plan order and joins them with the
 * plan's transition (`{"type": "fade", "seconds": 1}` = crossfade; "fadeblack"
 * dips through black), draws each shot's `caption` as a lower-left title card
 * (fades in at 0.8 s, out by 5 s), and the plan's `titles` (opening one at
 * `atSec`, closing one with `atEnd`). One ffmpeg pass; fonts from Windows'
 * Georgia. Output 4K60 H.264, yuv420p, faststart — ready for YouTube.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const plan = JSON.parse(fs.readFileSync(opt('plan'), 'utf8'));
const dir = path.resolve(opt('dir'));
const out = path.resolve(opt('out', path.join(dir, 'final.mp4')));
const ffmpeg = opt('ffmpeg', process.env.FFMPEG) ?? (() => {
  const b = path.join(process.env.APPDATA ?? '', 'Python', 'Python314', 'site-packages', 'imageio_ffmpeg', 'binaries');
  const f = fs.existsSync(b) && fs.readdirSync(b).find((x) => /^ffmpeg.*\.exe$/i.test(x));
  return f ? path.join(b, f) : 'ffmpeg';
})();
const fontDir = path.join(process.env.WINDIR ?? 'C:/Windows', 'Fonts').replace(/\\/g, '/');
const font = (f) => `${fontDir}/${f}`.replace(/:/g, '\\:');
const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');
const fade = plan.transition?.seconds ?? 1;
const ttype = plan.transition?.type ?? 'fade';

const shots = plan.shots.map((s) => ({ ...s, file: path.join(dir, `${s.name}.mp4`) }));
for (const s of shots) if (!fs.existsSync(s.file)) throw new Error(`missing ${s.file}`);

// alpha ramp: in over 0.6 s from a, hold, out over 0.6 s ending at b
const ramp = (a, b) =>
  `if(lt(t,${a}),0,if(lt(t,${a + 0.6}),(t-${a})/0.6,if(lt(t,${b - 0.6}),1,if(lt(t,${b}),(${b}-t)/0.6,0))))`;
const text = (t, size, x, y, a, b, bold = false) =>
  `drawtext=fontfile='${font(bold ? 'georgiab.ttf' : 'georgiai.ttf')}':text='${esc(t)}':fontsize=${size}:fontcolor=white` +
  `:shadowcolor=black@0.7:shadowx=4:shadowy=4:x=${x}:y=${y}:alpha='${ramp(a, b)}'`;

const parts = [];
shots.forEach((s, i) => {
  const f = [];
  if (s.caption) f.push(text(s.caption, 84, 140, 'h-220', 0.8 + (i ? fade : 0), 5 + (i ? fade : 0)));
  const opening = (plan.titles ?? []).find((t) => !t.atEnd);
  const closing = (plan.titles ?? []).find((t) => t.atEnd);
  if (i === 0 && opening) {
    const a = opening.atSec ?? 1.5;
    const b = a + (opening.durSec ?? 5);
    f.push(text(opening.text, 200, '(w-text_w)/2', '(h-text_h)/2-90', a, b, true));
    if (opening.sub) f.push(text(opening.sub, 70, '(w-text_w)/2', '(h-text_h)/2+90', a + 0.4, b));
  }
  if (i === shots.length - 1 && closing) {
    const b = s.seconds - 0.3;
    const a = b - (closing.durSec ?? 5);
    f.push(text(closing.text, 200, '(w-text_w)/2', '(h-text_h)/2-90', a, b, true));
    if (closing.sub) f.push(text(closing.sub, 70, '(w-text_w)/2', '(h-text_h)/2+90', a + 0.4, b));
  }
  if (i === 0) f.push('fade=t=in:st=0:d=1');
  if (i === shots.length - 1) f.push(`fade=t=out:st=${s.seconds - 1.2}:d=1.2`);
  // fps= LAST pins a constant rate: xfade refuses inputs whose rate reads 1/0, and
  // setpts (ffmpeg 7) marks its output variable-rate — an fps= before it is undone.
  const r = plan.fps ?? 60;
  parts.push(`[${i}:v]setpts=PTS-STARTPTS${f.length ? ',' + f.join(',') : ''},fps=${r}[v${i}]`);
});
let last = 'v0';
let offset = shots[0].seconds - fade;
for (let i = 1; i < shots.length; i++) {
  const lbl = `x${i}`;
  parts.push(`[${last}][v${i}]xfade=transition=${ttype}:duration=${fade}:offset=${offset.toFixed(3)}[${lbl}]`);
  last = lbl;
  offset += shots[i].seconds - fade;
}
const encoder = opt('encoder', 'libx264');
const encArgs =
  encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', opt('preset', 'fast'), '-crf', opt('crf', '16')]
    : ['-c:v', encoder, '-b:v', opt('bitrate', '80M')];
const args = [
  '-hide_banner', '-loglevel', 'error', '-stats', '-y',
  ...shots.flatMap((s) => ['-i', s.file]),
  '-filter_complex', parts.join(';'),
  '-map', `[${last}]`, ...encArgs, '-pix_fmt', 'yuv420p', '-r', String(plan.fps ?? 60),
  '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', out,
];
const total = offset + fade;
console.log(`[assemble] ${shots.length} shots, ${total.toFixed(1)} s -> ${out}`);
const p = spawn(ffmpeg, args, { stdio: ['ignore', 'inherit', 'inherit'] });
p.on('close', (code) => {
  console.log(`[assemble] ffmpeg exit ${code}`);
  process.exit(code ?? 1);
});
