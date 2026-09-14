// Shared test/build-time inputs. Native execution consumes captured binary
// records; it never imports JavaScript to construct expected numeric results.
export const NUMERIC_CONVERSION_TEXTS = (() => {
  const fraction = (n, places) => `0.${n.toString().padStart(places, '0')}`;
  const half = 5n ** 1075n;
  const normal = ((1n << 53n) - 1n) * half;
  const overflow = (1n << 1024n) - (1n << 970n);
  const middle = '1.00000000000000011102230246251565404236316680908203125';
  const cases = ['', ' ', '+', '-', '.', '.1', '1.', '+.1', '-0', '-0e99999999999',
    '01', '01.2', '1.e2', '1e', '1e+', '1e-3', '1e99999999999', '-1e-99999999999',
    'Infinity', '+Infinity', '-Infinity', 'infinity', 'Infinityx', 'NaN', '1_0', '1x',
    '0x', '0XfF', '+0x1', '-0x1', '0b10', '0B11', '0b2', '0o777', '0O10', '0o8',
    '0x`', '0xg', '0x1.2', '\ud800', '\udfff', '\u00851', '\u180e1', '\u200b1',
    '0.100000000000000005', '9007199254740993', '18446744073709551615',
    middle, middle + '0'.repeat(5000), middle + '0'.repeat(5000) + '1',
    fraction(half - 1n, 1075), fraction(half, 1075), fraction(half + 1n, 1075),
    fraction(normal - 1n, 1075), fraction(normal, 1075), fraction(normal + 1n, 1075),
    String(overflow - 1n), String(overflow), String(overflow + 1n),
    ...[2, 8, 16].flatMap(radix => {
      const prefix = { 2: '0b', 8: '0o', 16: '0x' }[radix];
      return [(1n << 53n) + 1n, (1n << 53n) + 3n, overflow - 1n, overflow, 1n << 1024n]
        .map(value => prefix + value.toString(radix));
    }),
  ];
  for (const code of [9, 10, 11, 12, 13, 32, 160, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) {
    const space = String.fromCharCode(code);
    cases.push(space, `${space}-1.25${space}`);
  }
  return cases;
})();
