/**
 * Small real files for the demo data: a signature drawing as a PNG and a one-page PDF, so that
 * signatures and printing can be tried without uploading anything first.
 */
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A scribble that differs by name, as a PNG data URL with a transparent background. */
export const signatureDataUrl = (name) => {
  const width = 240;
  const height = 80;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  const seed = [...name].reduce((sum, ch, i) => sum + ch.charCodeAt(0) * (i + 1), 0);
  const plot = (x, y) => {
    for (let dx = 0; dx < 2; dx += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        const px = Math.round(x) + dx;
        const py = Math.round(y) + dy;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          pixels[py * (width * 4 + 1) + 1 + px * 4 + 3] = 255; // black, fully opaque
        }
      }
    }
  };
  for (let x = 12; x < width - 12; x += 0.25) {
    const t = x / width;
    const y = 40 + 22 * Math.sin(t * (7 + (seed % 5)) + seed) * Math.cos(t * (13 + (seed % 7))) + 8 * Math.sin(t * 41);
    plot(x, y);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
};

const pdfText = (line) => line.replace(/[\\()]/g, (ch) => `\\${ch}`);

/** A one-page A4 PDF with these lines on it, the first one larger. */
export const demoPdf = (lines) => {
  const body = lines
    .map((line, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 60 ${770 - i * 24} Td (${pdfText(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${Buffer.byteLength(body)}>>\nstream\n${body}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
};
