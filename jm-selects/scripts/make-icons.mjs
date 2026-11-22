// One-off: renders the app icons. Run with `node scripts-make-icons.mjs`.
import sharp from 'sharp';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#2b2926"/>
  <rect x="${pad}" y="${pad}" width="${512 - 2 * pad}" height="${512 - 2 * pad}" fill="none" stroke="#c6a15b" stroke-width="6"/>
  <text x="256" y="300" text-anchor="middle" font-family="DejaVu Serif, Georgia, serif" font-size="170" fill="#c6a15b" letter-spacing="6">JM</text>
  <line x1="196" y1="350" x2="316" y2="350" stroke="#c6a15b" stroke-width="3"/>
</svg>`;
const out = 'web/public/icons/';
await sharp(Buffer.from(svg(40))).resize(512).png().toFile(out + 'icon-512.png');
await sharp(Buffer.from(svg(40))).resize(192).png().toFile(out + 'icon-192.png');
await sharp(Buffer.from(svg(40))).resize(180).png().toFile(out + 'apple-touch-icon.png');
await sharp(Buffer.from(svg(90))).resize(512).png().toFile(out + 'icon-maskable-512.png');
