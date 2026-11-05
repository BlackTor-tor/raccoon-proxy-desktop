/**
 * 极简二维码编码器(仅 byte 模式,版本 1-40,纠错级别 L/M/Q/H)
 *
 * 算法精简自 node-qrcode 核心(仅保留扫码授权用到的 byte 单段模式):
 *   Copyright (c) 2009 Kazuhiko Arase — http://www.d-project.com/
 *   Copyright (c) 2011 Ryan Day
 *   MIT License — http://www.opensource.org/licenses/mit-license.php
 * "QR Code" 是 DENSO WAVE INCORPORATED 的注册商标。
 *
 * 本项目要求零依赖,故把必要实现内联为单文件,不引入 npm 包。
 */
'use strict';

// ---- 基础常量表 ----
// 各版本总码字数(数据+纠错)
const CODEWORDS_COUNT = [
  0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
  2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706,
];

// 每版本分块数,按 L M Q H 排列
const EC_BLOCKS = [
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 2, 4, 1, 2, 4, 4,
  2, 4, 4, 4, 2, 4, 6, 5, 2, 4, 6, 6, 2, 5, 8, 8, 4, 5, 8, 8,
  4, 5, 8, 11, 4, 8, 10, 11, 4, 9, 12, 16, 4, 9, 16, 16, 6, 10, 12, 18,
  6, 10, 17, 16, 6, 11, 16, 19, 6, 13, 18, 21, 7, 14, 21, 25, 8, 16, 20, 25,
  8, 17, 23, 25, 9, 17, 23, 34, 9, 18, 25, 30, 10, 20, 27, 32, 12, 21, 29, 35,
  12, 23, 34, 37, 12, 25, 34, 40, 13, 26, 35, 42, 14, 28, 38, 45, 15, 29, 40, 48,
  16, 31, 43, 51, 17, 33, 45, 54, 18, 35, 48, 57, 19, 37, 51, 60, 19, 38, 53, 63,
  20, 40, 56, 66, 21, 43, 59, 70, 22, 45, 62, 74, 24, 47, 65, 77, 25, 49, 68, 81,
];

// 每版本纠错码字数,按 L M Q H 排列
const EC_CODEWORDS = [
  7, 10, 13, 17, 10, 16, 22, 28, 15, 26, 36, 44, 20, 36, 52, 64,
  26, 48, 72, 88, 36, 64, 96, 112, 40, 72, 108, 130, 48, 88, 132, 156,
  60, 110, 160, 192, 72, 130, 192, 224, 80, 150, 224, 264, 96, 176, 260, 308,
  104, 198, 288, 352, 120, 216, 320, 384, 132, 240, 360, 432, 144, 280, 408, 480,
  168, 308, 448, 532, 180, 338, 504, 588, 196, 364, 546, 650, 224, 416, 600, 700,
  224, 442, 644, 750, 252, 476, 690, 816, 270, 504, 750, 900, 300, 560, 810, 960,
  312, 588, 870, 1050, 336, 644, 952, 1110, 360, 700, 1020, 1200, 390, 728, 1050, 1260,
  420, 784, 1140, 1350, 450, 812, 1200, 1440, 480, 868, 1290, 1530, 510, 924, 1350, 1620,
  540, 980, 1440, 1710, 570, 1036, 1530, 1800, 570, 1064, 1590, 1890, 600, 1120, 1680, 1980,
  630, 1204, 1770, 2100, 660, 1260, 1860, 2220, 720, 1316, 1950, 2310, 750, 1372, 2040, 2430,
];

const LEVELS = { L: { index: 0, bit: 1 }, M: { index: 1, bit: 0 }, Q: { index: 2, bit: 3 }, H: { index: 3, bit: 2 } };

function levelOf(name) {
  return LEVELS[String(name || 'M').toUpperCase()] || LEVELS.M;
}

function symbolSize(version) {
  return version * 4 + 17;
}

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

// ---- GF(256) ----
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP_TABLE[i] = EXP_TABLE[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

function polyMul(p1, p2) {
  const coeff = new Uint8Array(p1.length + p2.length - 1);
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) coeff[i + j] ^= gfMul(p1[i], p2[j]);
  }
  return coeff;
}

function polyMod(dividend, divisor) {
  let result = new Uint8Array(dividend);
  while (result.length - divisor.length >= 0) {
    const coeff = result[0];
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], coeff);
    let offset = 0;
    while (offset < result.length && result[offset] === 0) offset++;
    result = result.slice(offset);
  }
  return result;
}

const genPolyCache = new Map();
function genPoly(degree) {
  if (genPolyCache.has(degree)) return genPolyCache.get(degree);
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) poly = polyMul(poly, new Uint8Array([1, EXP_TABLE[i]]));
  genPolyCache.set(degree, poly);
  return poly;
}

function rsEncode(data, degree) {
  const gen = genPoly(degree);
  const padded = new Uint8Array(data.length + degree);
  padded.set(data);
  const rest = polyMod(padded, gen);
  if (degree - rest.length > 0) {
    const out = new Uint8Array(degree);
    out.set(rest, degree - rest.length);
    return out;
  }
  return rest;
}

// ---- 位缓冲 ----
function BitBuffer() {
  this.buffer = [];
  this.length = 0;
}
BitBuffer.prototype.putBit = function (bit) {
  const idx = Math.floor(this.length / 8);
  if (this.buffer.length <= idx) this.buffer.push(0);
  if (bit) this.buffer[idx] |= 0x80 >>> this.length % 8;
  this.length++;
};
BitBuffer.prototype.put = function (num, length) {
  for (let i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) === 1);
};

// ---- 矩阵 ----
function BitMatrix(size) {
  this.size = size;
  this.data = new Uint8Array(size * size);
  this.reserved = new Uint8Array(size * size);
}
BitMatrix.prototype.set = function (row, col, value, reserved) {
  const i = row * this.size + col;
  this.data[i] = value ? 1 : 0;
  if (reserved) this.reserved[i] = 1;
};
BitMatrix.prototype.get = function (row, col) {
  return this.data[row * this.size + col];
};
BitMatrix.prototype.xor = function (row, col, value) {
  this.data[row * this.size + col] ^= value ? 1 : 0;
};
BitMatrix.prototype.isReserved = function (row, col) {
  return this.reserved[row * this.size + col];
};

// ---- 功能图形 ----
function setupFinder(matrix) {
  const size = matrix.size;
  const positions = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  for (const [row, col] of positions) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        matrix.set(row + r, col + c, dark, true);
      }
    }
  }
}

function setupTiming(matrix) {
  const size = matrix.size;
  for (let r = 8; r < size - 8; r++) {
    const value = r % 2 === 0;
    matrix.set(r, 6, value, true);
    matrix.set(6, r, value, true);
  }
}

function alignmentCoords(version) {
  if (version === 1) return [];
  const posCount = Math.floor(version / 7) + 2;
  const size = symbolSize(version);
  const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
  const positions = [size - 7];
  for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
  positions.push(6);
  return positions.reverse();
}

function setupAlignment(matrix, version) {
  const coords = alignmentCoords(version);
  if (!coords.length) return;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      const row = coords[i];
      const col = coords[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          matrix.set(row + r, col + c, dark, true);
        }
      }
    }
  }
}

function setupVersionInfo(matrix, version) {
  if (version < 7) return;
  const size = matrix.size;
  const G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
  const G18_BCH = bchDigit(G18);
  let d = version << 12;
  while (bchDigit(d) - G18_BCH >= 0) d ^= G18 << (bchDigit(d) - G18_BCH);
  const bits = (version << 12) | d;

  for (let i = 0; i < 18; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) + size - 11;
    const dark = ((bits >> i) & 1) === 1;
    matrix.set(row, col, dark, true);
    matrix.set(col, row, dark, true);
  }
}

function setupFormatInfo(matrix, level, maskPattern) {
  const size = matrix.size;
  const G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
  const G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
  const G15_BCH = bchDigit(G15);

  const data = (level.bit << 3) | maskPattern;
  let d = data << 10;
  while (bchDigit(d) - G15_BCH >= 0) d ^= G15 << (bchDigit(d) - G15_BCH);
  const bits = ((data << 10) | d) ^ G15_MASK;

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // 垂直
    if (i < 6) matrix.set(i, 8, dark, true);
    else if (i < 8) matrix.set(i + 1, 8, dark, true);
    else matrix.set(size - 15 + i, 8, dark, true);
    // 水平
    if (i < 8) matrix.set(8, size - i - 1, dark, true);
    else if (i < 9) matrix.set(8, 15 - i, dark, true);
    else matrix.set(8, 15 - i - 1, dark, true);
  }
  matrix.set(size - 8, 8, 1, true); // 固定深色模块
}

function setupData(matrix, data) {
  const size = matrix.size;
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (!matrix.isReserved(row, col - c)) {
          let dark = false;
          if (byteIndex < data.length) dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          matrix.set(row, col - c, dark, false);
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

// ---- 掩码 ----
function maskAt(pattern, i, j) {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error(`bad mask: ${pattern}`);
  }
}

function applyMask(pattern, matrix) {
  const size = matrix.size;
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (matrix.isReserved(row, col)) continue;
      matrix.xor(row, col, maskAt(pattern, row, col));
    }
  }
}

function penalty(matrix) {
  const size = matrix.size;
  let points = 0;

  // N1: 同色连续 5 个以上
  for (let row = 0; row < size; row++) {
    let sameCol = 0;
    let sameRow = 0;
    let lastCol = null;
    let lastRow = null;
    for (let col = 0; col < size; col++) {
      const a = matrix.get(row, col);
      if (a === lastCol) sameCol++;
      else {
        if (sameCol >= 5) points += 3 + (sameCol - 5);
        lastCol = a;
        sameCol = 1;
      }
      const b = matrix.get(col, row);
      if (b === lastRow) sameRow++;
      else {
        if (sameRow >= 5) points += 3 + (sameRow - 5);
        lastRow = b;
        sameRow = 1;
      }
    }
    if (sameCol >= 5) points += 3 + (sameCol - 5);
    if (sameRow >= 5) points += 3 + (sameRow - 5);
  }

  // N2: 2x2 同色块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum = matrix.get(row, col) + matrix.get(row, col + 1) + matrix.get(row + 1, col) + matrix.get(row + 1, col + 1);
      if (sum === 4 || sum === 0) points += 3;
    }
  }

  // N3: 1:1:3:1:1 特征
  for (let row = 0; row < size; row++) {
    let bitsCol = 0;
    let bitsRow = 0;
    for (let col = 0; col < size; col++) {
      bitsCol = ((bitsCol << 1) & 0x7ff) | matrix.get(row, col);
      if (col >= 10 && (bitsCol === 0x5d0 || bitsCol === 0x05d)) points += 40;
      bitsRow = ((bitsRow << 1) & 0x7ff) | matrix.get(col, row);
      if (col >= 10 && (bitsRow === 0x5d0 || bitsRow === 0x05d)) points += 40;
    }
  }

  // N4: 深浅比例偏离 50%
  let dark = 0;
  for (let i = 0; i < matrix.data.length; i++) dark += matrix.data[i];
  const k = Math.abs(Math.ceil((dark * 100) / matrix.data.length / 5) - 10);
  points += k * 10;

  return points;
}

// ---- 数据编码(byte 模式单段) ----
function buildCodewords(bytes, version, level) {
  const totalCodewords = CODEWORDS_COUNT[version];
  const ecTotal = EC_CODEWORDS[(version - 1) * 4 + level.index];
  const dataTotal = totalCodewords - ecTotal;
  const dataBits = dataTotal * 8;

  const buffer = new BitBuffer();
  buffer.put(0b0100, 4); // byte 模式
  buffer.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) buffer.put(b, 8);

  if (buffer.length + 4 <= dataBits) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(0);
  const remaining = (dataBits - buffer.length) / 8;
  for (let i = 0; i < remaining; i++) buffer.put(i % 2 ? 0x11 : 0xec, 8);

  // 分块 + RS 纠错 + 交织
  const blocks = EC_BLOCKS[(version - 1) * 4 + level.index];
  const blocksInGroup2 = totalCodewords % blocks;
  const blocksInGroup1 = blocks - blocksInGroup2;
  const totalInGroup1 = Math.floor(totalCodewords / blocks);
  const dataInGroup1 = Math.floor(dataTotal / blocks);
  const dataInGroup2 = dataInGroup1 + 1;
  const ecCount = totalInGroup1 - dataInGroup1;

  const src = new Uint8Array(buffer.buffer);
  const dc = new Array(blocks);
  const ec = new Array(blocks);
  let offset = 0;
  let maxDataSize = 0;
  for (let b = 0; b < blocks; b++) {
    const size = b < blocksInGroup1 ? dataInGroup1 : dataInGroup2;
    dc[b] = src.slice(offset, offset + size);
    ec[b] = rsEncode(dc[b], ecCount);
    offset += size;
    maxDataSize = Math.max(maxDataSize, size);
  }

  const out = new Uint8Array(totalCodewords);
  let idx = 0;
  for (let i = 0; i < maxDataSize; i++) {
    for (let b = 0; b < blocks; b++) if (i < dc[b].length) out[idx++] = dc[b][i];
  }
  for (let i = 0; i < ecCount; i++) {
    for (let b = 0; b < blocks; b++) out[idx++] = ec[b][i];
  }
  return out;
}

function pickVersion(byteLength, level) {
  for (let version = 1; version <= 40; version++) {
    const total = CODEWORDS_COUNT[version];
    const ecTotal = EC_CODEWORDS[(version - 1) * 4 + level.index];
    const dataBits = (total - ecTotal) * 8;
    const ccBits = version < 10 ? 8 : 16;
    if (4 + ccBits + byteLength * 8 <= dataBits) return version;
  }
  return null;
}

/**
 * 生成二维码矩阵
 * @param {string} text 待编码文本(按 UTF-8 字节)
 * @param {{level?: string, mask?: number}} [options]
 * @returns {{size:number, modules:Uint8Array, version:number, level:string, mask:number}}
 */
function encode(text, options = {}) {
  const levelName = String(options.level || 'M').toUpperCase();
  const level = levelOf(levelName);
  const bytes = Buffer.from(String(text), 'utf8');

  const version = pickVersion(bytes.length, level);
  if (!version) throw new Error('二维码内容过长,无法编码');

  const codewords = buildCodewords(bytes, version, level);
  const size = symbolSize(version);
  const matrix = new BitMatrix(size);

  setupFinder(matrix);
  setupTiming(matrix);
  setupAlignment(matrix, version);
  setupFormatInfo(matrix, level, 0); // 先占位保留格式区
  setupVersionInfo(matrix, version);
  setupData(matrix, codewords);

  let mask = options.mask;
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) {
    let best = 0;
    let lowest = Infinity;
    for (let p = 0; p < 8; p++) {
      setupFormatInfo(matrix, level, p);
      applyMask(p, matrix);
      const score = penalty(matrix);
      applyMask(p, matrix);
      if (score < lowest) {
        lowest = score;
        best = p;
      }
    }
    mask = best;
  }

  applyMask(mask, matrix);
  setupFormatInfo(matrix, level, mask);

  return { size, modules: matrix.data, version, level: levelName, mask };
}

/** 终端/纯文本渲染: 用半块字符把两行压成一行,深色为 █ */
function toText(qr, options = {}) {
  const quiet = options.quiet ?? 2;
  const { size, modules } = qr;
  const dark = (r, c) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return 0;
    return modules[r * size + c];
  };
  const lines = [];
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < size + quiet; c++) {
      const top = dark(r, c);
      const bottom = r + 1 < size + quiet ? dark(r + 1, c) : 0;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** SVG 渲染(本地授权页使用) */
function toSvg(qr, options = {}) {
  const quiet = options.quiet ?? 4;
  const scale = options.scale ?? 8;
  const { size, modules } = qr;
  const dim = (size + quiet * 2) * scale;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r * size + c]) pathData += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${pathData}" fill="#000"/></svg>`;
}

module.exports = { encode, toText, toSvg };
