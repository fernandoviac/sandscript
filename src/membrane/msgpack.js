/**
 * Local msgpack encode/decode for the membrane's value arena
 * (_writeArenaValue / _readArenaValue in index.js).
 *
 * This replaces an external CDN import (urania.blue/urania/libs/msgpack)
 * that duplicated functionality already present elsewhere in this
 * codebase — a full msgpack encoder/decoder is implemented natively in
 * the WAT interpreter (interpreter.wat's $msgpack_encode_value /
 * $msgpack_decode_any, exposed to SandScript programs as the `msgpack`
 * builtin) and a msgpack decoder already exists in JS
 * (memory-reader.js's unmarshalMsgpack*, used for host-side readback of
 * a script's own msgpack.encode output). Neither of those is reusable
 * as-is here — the WAT one only runs inside interpreted script
 * execution, and the JS one is tightly coupled to MemoryReader's view
 * over the interpreter's linear memory — so this is a small standalone
 * pair operating on plain Uint8Array/DataView, matching the same wire
 * format both of those already speak.
 *
 * Scope: the value space actually stored in the arena (see call sites
 * of _writeArenaValue in index.js) is plain JSON-shaped data — null,
 * booleans, numbers, strings, arrays, plain objects — plus Uint8Array
 * passthrough for parity with the wire format's bin types. Also used
 * by runtime/serialize-error.js as an encodability probe, which needs
 * BigInt to survive (serializeThrownError's documented contract, pinned
 * by tests/runtime/serialize_error_test.js); BigInt round-trips via one
 * application-defined ext type (sign byte + big-endian magnitude — see
 * EXT_TYPE_BIGINT), the standard msgpack mechanism for values outside
 * the base type set. No other extension types, no timestamps, no map
 * keys other than strings.
 */

// ============================================================================
// Encode
// ============================================================================

/**
 * Encode a JS value to msgpack bytes.
 * @param {*} value
 * @returns {Uint8Array}
 */
export function encode(value) {
  const chunks = [];
  encodeValue(value, chunks);
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function encodeValue(value, chunks) {
  if (value === null || value === undefined) {
    chunks.push(Uint8Array.of(0xc0));
    return;
  }
  if (value === false) {
    chunks.push(Uint8Array.of(0xc2));
    return;
  }
  if (value === true) {
    chunks.push(Uint8Array.of(0xc3));
    return;
  }
  if (typeof value === 'number') {
    encodeNumber(value, chunks);
    return;
  }
  if (typeof value === 'bigint') {
    encodeBigInt(value, chunks);
    return;
  }
  if (typeof value === 'string') {
    encodeString(value, chunks);
    return;
  }
  if (value instanceof Uint8Array) {
    encodeBin(value, chunks);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(value, chunks);
    return;
  }
  if (typeof value === 'object') {
    encodeMap(value, chunks);
    return;
  }
  throw new TypeError(`msgpack encode: unsupported value type ${typeof value}`);
}

function encodeNumber(value, chunks) {
  // Integral doubles outside the 64-bit integer range have no msgpack
  // integer form; they stay float64 (1e308 is Number.isInteger).
  if (Number.isInteger(value) && value < 18446744073709551616 && value >= -9223372036854775808) {
    encodeInteger(value, chunks);
    return;
  }
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 0xcb);
  view.setFloat64(1, value, false);
  chunks.push(new Uint8Array(buf));
}

function encodeInteger(value, chunks) {
  if (value >= 0) {
    if (value <= 0x7f) {
      chunks.push(Uint8Array.of(value));
      return;
    }
    if (value <= 0xff) {
      chunks.push(Uint8Array.of(0xcc, value));
      return;
    }
    if (value <= 0xffff) {
      const buf = new ArrayBuffer(3);
      const view = new DataView(buf);
      view.setUint8(0, 0xcd);
      view.setUint16(1, value, false);
      chunks.push(new Uint8Array(buf));
      return;
    }
    if (value <= 0xffffffff) {
      const buf = new ArrayBuffer(5);
      const view = new DataView(buf);
      view.setUint8(0, 0xce);
      view.setUint32(1, value, false);
      chunks.push(new Uint8Array(buf));
      return;
    }
    // uint64 range — split into hi/lo 32-bit halves (matches the
    // decoder's `hi * 4294967296 + lo` reconstruction).
    const buf = new ArrayBuffer(9);
    const view = new DataView(buf);
    view.setUint8(0, 0xcf);
    const hi = Math.floor(value / 4294967296);
    const lo = value >>> 0;
    view.setUint32(1, hi, false);
    view.setUint32(5, lo, false);
    chunks.push(new Uint8Array(buf));
    return;
  }

  // Negative integers.
  if (value >= -32) {
    chunks.push(Uint8Array.of(value & 0xff));
    return;
  }
  if (value >= -128) {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setInt8(1, value);
    const out = new Uint8Array(buf);
    out[0] = 0xd0;
    chunks.push(out);
    return;
  }
  if (value >= -32768) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0xd1);
    view.setInt16(1, value, false);
    chunks.push(new Uint8Array(buf));
    return;
  }
  if (value >= -2147483648) {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0xd2);
    view.setInt32(1, value, false);
    chunks.push(new Uint8Array(buf));
    return;
  }
  // int64 range — split into hi/lo 32-bit halves (matches the
  // decoder's `hi * 4294967296 + lo` reconstruction, hi carrying sign).
  const buf = new ArrayBuffer(9);
  const view = new DataView(buf);
  view.setUint8(0, 0xd3);
  const hi = Math.floor(value / 4294967296);
  const lo = value >>> 0;
  view.setInt32(1, hi, false);
  view.setUint32(5, lo, false);
  chunks.push(new Uint8Array(buf));
}

// Application-defined ext type for BigInt: sign byte (0 = non-negative,
// 1 = negative) followed by the big-endian magnitude bytes. Encoded as
// a standard msgpack ext (fixext/ext8/16/32) so it round-trips through
// this module's own decode() — nothing else in this codebase reads
// this specific byte layout, so any correct, self-consistent ext
// encoding is fine; this one just follows the spec's actual mechanism
// for application-defined types instead of a special-cased hack.
const EXT_TYPE_BIGINT = 0x01;

function encodeBigInt(value, chunks) {
  const sign = value < 0n ? 1 : 0;
  let magnitude = value < 0n ? -value : value;
  const bytes = [];
  while (magnitude > 0n) {
    bytes.unshift(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  const payload = new Uint8Array(1 + bytes.length);
  payload[0] = sign;
  payload.set(bytes, 1);
  encodeExt(EXT_TYPE_BIGINT, payload, chunks);
}

function encodeExt(type, payload, chunks) {
  const len = payload.byteLength;
  if (len === 1) {
    chunks.push(Uint8Array.of(0xd4, type));
  } else if (len === 2) {
    chunks.push(Uint8Array.of(0xd5, type));
  } else if (len === 4) {
    chunks.push(Uint8Array.of(0xd6, type));
  } else if (len === 8) {
    chunks.push(Uint8Array.of(0xd7, type));
  } else if (len === 16) {
    chunks.push(Uint8Array.of(0xd8, type));
  } else if (len <= 0xff) {
    chunks.push(Uint8Array.of(0xc7, len, type));
  } else if (len <= 0xffff) {
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, 0xc8);
    view.setUint16(1, len, false);
    view.setUint8(3, type);
    chunks.push(new Uint8Array(buf));
  } else {
    const buf = new ArrayBuffer(6);
    const view = new DataView(buf);
    view.setUint8(0, 0xc9);
    view.setUint32(1, len, false);
    view.setUint8(5, type);
    chunks.push(new Uint8Array(buf));
  }
  chunks.push(payload);
}

function encodeString(value, chunks) {
  const bytes = utf8Encoder.encode(value);
  const len = bytes.byteLength;
  if (len <= 0x1f) {
    chunks.push(Uint8Array.of(0xa0 | len));
  } else if (len <= 0xff) {
    chunks.push(Uint8Array.of(0xd9, len));
  } else if (len <= 0xffff) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0xda);
    view.setUint16(1, len, false);
    chunks.push(new Uint8Array(buf));
  } else {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0xdb);
    view.setUint32(1, len, false);
    chunks.push(new Uint8Array(buf));
  }
  chunks.push(bytes);
}

function encodeBin(value, chunks) {
  const len = value.byteLength;
  if (len <= 0xff) {
    chunks.push(Uint8Array.of(0xc4, len));
  } else if (len <= 0xffff) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0xc5);
    view.setUint16(1, len, false);
    chunks.push(new Uint8Array(buf));
  } else {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0xc6);
    view.setUint32(1, len, false);
    chunks.push(new Uint8Array(buf));
  }
  chunks.push(value);
}

function encodeArray(value, chunks) {
  const len = value.length;
  if (len <= 0x0f) {
    chunks.push(Uint8Array.of(0x90 | len));
  } else if (len <= 0xffff) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0xdc);
    view.setUint16(1, len, false);
    chunks.push(new Uint8Array(buf));
  } else {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0xdd);
    view.setUint32(1, len, false);
    chunks.push(new Uint8Array(buf));
  }
  for (const item of value) {
    encodeValue(item, chunks);
  }
}

function encodeMap(value, chunks) {
  const keys = Object.keys(value);
  const len = keys.length;
  if (len <= 0x0f) {
    chunks.push(Uint8Array.of(0x80 | len));
  } else if (len <= 0xffff) {
    const buf = new ArrayBuffer(3);
    const view = new DataView(buf);
    view.setUint8(0, 0xde);
    view.setUint16(1, len, false);
    chunks.push(new Uint8Array(buf));
  } else {
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, 0xdf);
    view.setUint32(1, len, false);
    chunks.push(new Uint8Array(buf));
  }
  for (const key of keys) {
    encodeString(key, chunks);
    encodeValue(value[key], chunks);
  }
}

// ============================================================================
// Decode
// ============================================================================

/**
 * Decode msgpack bytes to a JS value.
 * @param {Uint8Array} bytes
 * @returns {*}
 */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Short ASCII strings (keys, keywords, pointers) are built from char codes
// directly; everything else goes through one shared TextDecoder.
const charCodes = [];
function decodeString(u8, start, len) {
  if (len <= 32) {
    let code = 0;
    charCodes.length = len;
    for (let i = 0; i < len; i++) code |= (charCodes[i] = u8[start + i]);
    if ((code & 0x80) === 0) {
      if (len >= 8) return String.fromCharCode.apply(null, charCodes);
      let str = '';
      for (let i = 0; i < len; i++) str += String.fromCharCode(charCodes[i]);
      return str;
    }
  }
  return utf8Decoder.decode(u8.subarray(start, start + len));
}

export function decode(bytes) {
  const savedU8 = u8, savedView = view, savedPos = pos, savedEnd = end;
  u8 = bytes;
  view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  pos = 0;
  end = bytes.byteLength;
  try {
    return decodeValue();
  } finally {
    u8 = savedU8; view = savedView; pos = savedPos; end = savedEnd;
  }
}

// Decoder cursor. One value is decoded at a time; the cursor lives in
// module state so containers cost no per-element result objects.
let u8 = null;
let view = null;
let pos = 0;
let end = 0;

function decodeValue() {
  if (pos >= end) return undefined;
  const addr = pos;
  const byte = u8[addr];

  // Positive fixint (0x00-0x7f)
  if (byte <= 0x7f) { pos = addr + 1; return byte; }
  // Negative fixint (0xe0-0xff)
  if (byte >= 0xe0) { pos = addr + 1; return (byte | 0xffffff00) >> 0; }
  // Fixmap (0x80-0x8f)
  if (byte <= 0x8f) { pos = addr + 1; return decodeMap(byte & 0x0f); }
  // Fixarray (0x90-0x9f)
  if (byte <= 0x9f) { pos = addr + 1; return decodeArray(byte & 0x0f); }
  // Fixstr (0xa0-0xbf)
  if (byte <= 0xbf) {
    const len = byte & 0x1f;
    pos = addr + 1 + len;
    return decodeString(u8, addr + 1, len);
  }

  switch (byte) {
    case 0xc0: pos = addr + 1; return null;
    case 0xc2: pos = addr + 1; return false;
    case 0xc3: pos = addr + 1; return true;

    // bin8/16/32
    case 0xc4: { const len = u8[addr + 1]; pos = addr + 2 + len; return u8.slice(addr + 2, pos); }
    case 0xc5: { const len = view.getUint16(addr + 1, false); pos = addr + 3 + len; return u8.slice(addr + 3, pos); }
    case 0xc6: { const len = view.getUint32(addr + 1, false); pos = addr + 5 + len; return u8.slice(addr + 5, pos); }

    // ext8/16/32 (variable-length header)
    case 0xc7: return decodeExt(u8[addr + 2], addr + 3, u8[addr + 1]);
    case 0xc8: return decodeExt(u8[addr + 3], addr + 4, view.getUint16(addr + 1, false));
    case 0xc9: return decodeExt(u8[addr + 5], addr + 6, view.getUint32(addr + 1, false));
    // fixext1/2/4/8/16 (fixed-length header)
    case 0xd4: return decodeExt(u8[addr + 1], addr + 2, 1);
    case 0xd5: return decodeExt(u8[addr + 1], addr + 2, 2);
    case 0xd6: return decodeExt(u8[addr + 1], addr + 2, 4);
    case 0xd7: return decodeExt(u8[addr + 1], addr + 2, 8);
    case 0xd8: return decodeExt(u8[addr + 1], addr + 2, 16);

    // float32/64
    case 0xca: pos = addr + 5; return view.getFloat32(addr + 1, false);
    case 0xcb: pos = addr + 9; return view.getFloat64(addr + 1, false);

    // uint8/16/32/64
    case 0xcc: pos = addr + 2; return u8[addr + 1];
    case 0xcd: pos = addr + 3; return view.getUint16(addr + 1, false);
    case 0xce: pos = addr + 5; return view.getUint32(addr + 1, false);
    case 0xcf: pos = addr + 9; return view.getUint32(addr + 1, false) * 4294967296 + view.getUint32(addr + 5, false);

    // int8/16/32/64
    case 0xd0: pos = addr + 2; return view.getInt8(addr + 1);
    case 0xd1: pos = addr + 3; return view.getInt16(addr + 1, false);
    case 0xd2: pos = addr + 5; return view.getInt32(addr + 1, false);
    case 0xd3: pos = addr + 9; return view.getInt32(addr + 1, false) * 4294967296 + view.getUint32(addr + 5, false);

    // str8/16/32
    case 0xd9: { const len = u8[addr + 1]; pos = addr + 2 + len; return decodeString(u8, addr + 2, len); }
    case 0xda: { const len = view.getUint16(addr + 1, false); pos = addr + 3 + len; return decodeString(u8, addr + 3, len); }
    case 0xdb: { const len = view.getUint32(addr + 1, false); pos = addr + 5 + len; return decodeString(u8, addr + 5, len); }

    // array16/32
    case 0xdc: pos = addr + 3; return decodeArray(view.getUint16(addr + 1, false));
    case 0xdd: pos = addr + 5; return decodeArray(view.getUint32(addr + 1, false));

    // map16/32
    case 0xde: pos = addr + 3; return decodeMap(view.getUint16(addr + 1, false));
    case 0xdf: pos = addr + 5; return decodeMap(view.getUint32(addr + 1, false));
  }

  throw new Error(`msgpack decode: unsupported type byte 0x${byte.toString(16)} at offset ${addr}`);
}

function decodeExt(type, payloadAddr, len) {
  if (type === EXT_TYPE_BIGINT) {
    const sign = u8[payloadAddr];
    let magnitude = 0n;
    for (let i = 1; i < len; i++) {
      magnitude = (magnitude << 8n) | BigInt(u8[payloadAddr + i]);
    }
    pos = payloadAddr + len;
    return sign === 1 ? -magnitude : magnitude;
  }
  throw new Error(`msgpack decode: unsupported ext type ${type}`);
}

function decodeArray(count) {
  const arr = new Array(count);
  for (let i = 0; i < count; i++) arr[i] = decodeValue();
  return arr;
}

function decodeMap(count) {
  const obj = {};
  for (let i = 0; i < count; i++) {
    const key = decodeValue();
    const val = decodeValue();
    if (typeof key === 'string') obj[key] = val;
  }
  return obj;
}
