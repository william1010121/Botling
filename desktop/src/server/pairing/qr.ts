// A QR code for the terminal (`botlingd pair`, protocol v1 §4.4 step 1). The 2.x encoder
// (src/mobile-bridge/qr.ts: byte mode, error correction M, versions 1–10, at most 213 bytes) is imported-never-edited
// and too small for a Botling 3 pairing link (an offer carries two keys, the secret, the cluster and the server, about
// 600 bytes), so this is the same algorithm (ISO/IEC 18004 model 2, as Project Nayuki's reference generator) with the
// error-correction tables for every version (1–40, level M). Pure: no I/O, nothing logged (the link holds the secret).

// Error correction M: codewords per block and block count, indexed by version (ISO/IEC 18004 table 9).
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

const rawModules = (version: number) => {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
};
const dataCodewords = (version: number) => Math.floor(rawModules(version) / 8) - EC_PER_BLOCK[version] * BLOCKS[version];

function reedSolomon(data: number[], degree: number): number[] {
  const mul = (x: number, y: number) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; } return z; };
  const divisor = new Array(degree).fill(0); divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { divisor[j] = mul(divisor[j], root); if (j + 1 < degree) divisor[j] ^= divisor[j + 1]; }
    root = mul(root, 0x02);
  }
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number); result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= mul(coef, factor); });
  }
  return result;
}

/** Returns the modules of the code, row by row (true is dark). Throws when the text is too long. */
export function qrModules(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 40 && bytes.length > dataCodewords(version) - (version < 10 ? 2 : 3)) version++;
  if (version > 40) throw new RangeError('Text is too long for a QR code.');
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4); put(bytes.length, version < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCodewords(version); pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction, interleave.
  const blocks = BLOCKS[version], short = blocks - (Math.floor(rawModules(version) / 8) % blocks), shortLength = Math.floor(rawModules(version) / 8 / blocks);
  const parts: number[][] = []; const ecc: number[][] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortLength - EC_PER_BLOCK[version] + (i < short ? 0 : 1);
    const block = data.slice(at, at + length); at += length;
    parts.push(block); ecc.push(reedSolomon(block, EC_PER_BLOCK[version]));
  }
  const codewords: number[] = [];
  for (let i = 0; i < parts[parts.length - 1].length; i++) parts.forEach((block, j) => { if (i !== shortLength - EC_PER_BLOCK[version] || j >= short) codewords.push(block[i]); });
  for (let i = 0; i < EC_PER_BLOCK[version]; i++) ecc.forEach(block => codewords.push(block[i]));

  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, value: boolean) => { dark[y][x] = value; fixed[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
    const positions = [6]; for (let p = size - 7; positions.length < count; p -= step) positions.splice(1, 0, p);
    for (const cy of positions) for (const cx of positions) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const format = (mask: number) => {
    const raw = (0b00 << 3) | mask; // error correction M is 00
    let rem = raw; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const value = ((raw << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((value >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (version >= 7) {
    let rem = version; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const value = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((value >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }
  // Place data bits in the zigzag order.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fixed[y][x] && index < codewords.length * 8) { dark[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0; index++; }
    }
  }
  const masks: ((x: number, y: number) => boolean)[] = [
    (x, y) => (x + y) % 2 === 0, (_x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const apply = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && masks[mask](x, y)) dark[y][x] = !dark[y][x];
  };
  let best = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    apply(mask); format(mask);
    const penalty = penaltyOf(dark);
    if (penalty < bestPenalty) { best = mask; bestPenalty = penalty; }
    apply(mask); // undo
  }
  apply(best); format(best);
  return dark;
}

/** The standard's four penalty rules, simplified to runs, 2x2 blocks, finder-like patterns and balance. */
function penaltyOf(dark: boolean[][]): number {
  const size = dark.length; let penalty = 0;
  for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) {
    let run = 1, bits = '';
    for (let b = 0; b < size; b++) {
      const cell = pass ? dark[b][a] : dark[a][b];
      bits += cell ? '1' : '0';
      if (b > 0 && cell === (pass ? dark[b - 1][a] : dark[a][b - 1])) { run++; if (run === 5) penalty += 3; else if (run > 5) penalty++; } else run = 1;
    }
    for (const pattern of ['10111010000', '00001011101']) { let at = bits.indexOf(pattern); while (at >= 0) { penalty += 40; at = bits.indexOf(pattern, at + 1); } }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) penalty += 3;
  const total = size * size, count = dark.flat().filter(Boolean).length;
  return penalty + Math.floor(Math.abs(count * 20 - total * 10) / total) * 10;
}


/**
 * The code as terminal text: two module rows per line with half blocks (dark modules drawn in the terminal's
 * foreground colour on its background, so the result is inverted: `invert` true draws light-on-dark terminals the right
 * way round), with a quiet zone of `quiet` modules.
 */
export function qrTerminal(text: string, options: { quiet?: number; invert?: boolean } = {}): string {
  const modules = qrModules(text);
  const quiet = options.quiet ?? 2;
  const invert = options.invert ?? true;
  const size = modules.length + quiet * 2;
  const dark = (x: number, y: number) => {
    const mx = x - quiet, my = y - quiet;
    const on = mx >= 0 && my >= 0 && mx < modules.length && my < modules.length && modules[my]![mx]!;
    return invert ? !on : on;
  };
  const lines: string[] = [];
  for (let y = 0; y < size; y += 2) {
    let line = "";
    for (let x = 0; x < size; x++) {
      const top = dark(x, y), bottom = y + 1 < size ? dark(x, y + 1) : invert;
      line += top && bottom ? "\u2588" : top ? "\u2580" : bottom ? "\u2584" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
