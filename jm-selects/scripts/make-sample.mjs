// Creates ./sample-photos with the NAS folder layout and some test JPEGs (+ fake RAWs).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const root = process.argv[2] ?? 'sample-photos';
const count = Number(process.argv[3] ?? 60);
const client = path.join(root, '2026', 'Week 47 backup', 'Naidoo Family');
fs.mkdirSync(client, { recursive: true });
fs.mkdirSync(path.join(root, '2026', 'Week 47 backup', 'Mokoena Maternity'), { recursive: true });
fs.mkdirSync(path.join(root, '2026', 'Week 47', 'Card A', 'first copy'), { recursive: true });
fs.mkdirSync(path.join(root, '2025', 'Week 50 backup'), { recursive: true });
const tones = [[214, 196, 168], [120, 98, 80], [60, 58, 55], [190, 160, 120], [235, 225, 210], [150, 130, 110]];
for (let i = 1; i <= count; i++) {
  const [r, g, b] = tones[i % tones.length];
  const portrait = i % 4 !== 0;
  const [w, h] = portrait ? [2400, 3600] : [3600, 2400];
  const label = `JM_${String(i).padStart(4, '0')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><radialGradient id="g" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="rgb(${r + 20},${g + 20},${b + 20})"/><stop offset="1" stop-color="rgb(${r - 40},${g - 40},${b - 40})"/></radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <ellipse cx="${w / 2}" cy="${h * 0.42}" rx="${w * 0.14}" ry="${w * 0.18}" fill="rgba(40,35,30,0.55)"/>
    <rect x="${w * 0.3}" y="${h * 0.58}" width="${w * 0.4}" height="${h * 0.45}" rx="${w * 0.12}" fill="rgba(40,35,30,0.55)"/>
    <text x="${w / 2}" y="${h * 0.94}" text-anchor="middle" font-family="DejaVu Serif" font-size="${w * 0.05}" fill="rgba(255,255,255,0.7)">${label}</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(path.join(client, `${label}.jpg`));
  fs.writeFileSync(path.join(client, `${label}.CR3`), 'raw placeholder');
}
await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#998877' } }).jpeg().toFile(path.join(root, '2026', 'Week 47 backup', 'Mokoena Maternity', 'MM_0001.jpg'));
console.log(`Sample folder ready: ${root} (${count} JPEGs in ${client})`);
