/**
 * Which tyre LPO lines fit a bus (owner's testing notes, 2026-11-11). Sizes are written many ways:
 * "295/80 R22.5", "R22.5 80-295" on the client's LPOs, or just "22.5". They are matched by rim
 * diameter, and by width and profile when both sizes give them. Text with no rim in it is
 * compared as written, ignoring case and spaces.
 */

/** `{ rim, width, profile }` read from a size; each is null when the size does not give it. */
export const readTyreSize = (size) => {
  const text = String(size ?? '').trim();
  const rim = text.match(/R\s*(\d{2}(?:\.\d)?)(?![\d.])/i)?.[1] ?? text.match(/(?<![\d.])(\d{2}\.\d)(?![\d.])/)?.[1] ?? text.match(/^(\d{2})$/)?.[1];
  // 295/80 is width over profile; the client's LPOs write it the other way round, as 80-295.
  const slash = text.match(/(?<!\d)(\d{3})\s*\/\s*(\d{2})(?!\d)/);
  const dash = text.match(/(?<!\d)(\d{2})\s*-\s*(\d{3})(?!\d)/);
  const width = slash?.[1] ?? dash?.[2];
  const profile = slash?.[2] ?? dash?.[1];
  return { rim: rim ? Number(rim) : null, width: width ? Number(width) : null, profile: profile ? Number(profile) : null };
};

const plain = (size) => String(size ?? '').replace(/\s+/g, '').toLowerCase();

/** Whether a tyre line of `lineSize` fits a bus whose tyres are `busSize`. A bus with no size takes every line. */
export const tyreSizeFits = (busSize, lineSize) => {
  if (!plain(busSize)) return true;
  const bus = readTyreSize(busSize);
  const line = readTyreSize(lineSize);
  if (bus.rim === null || line.rim === null) return plain(busSize) === plain(lineSize);
  if (bus.rim !== line.rim) return false;
  const both = bus.width !== null && line.width !== null && bus.profile !== null && line.profile !== null;
  return !both || (bus.width === line.width && bus.profile === line.profile);
};
