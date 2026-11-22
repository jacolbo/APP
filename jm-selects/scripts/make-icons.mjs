// Renders the app icons to match the jepsonmyles.co.za favicon (italic "JM" in Bodoni Moda on ink).
// Needs Bodoni Moda Italic installed as a system font while running: node scripts/make-icons.mjs
import sharp from 'sharp';
const svg = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#171310"/>
  <text x="256" y="${256 + 70 * scale}" text-anchor="middle" font-family="Bodoni Moda" font-style="italic"
        font-size="${240 * scale}" fill="#FCFCFB">JM</text>
</svg>`;
const out = 'web/public/icons/';
await sharp(Buffer.from(svg(1))).resize(512).png().toFile(out + 'icon-512.png');
await sharp(Buffer.from(svg(1))).resize(192).png().toFile(out + 'icon-192.png');
await sharp(Buffer.from(svg(1))).resize(180).png().toFile(out + 'apple-touch-icon.png');
await sharp(Buffer.from(svg(0.75))).resize(512).png().toFile(out + 'icon-maskable-512.png');
