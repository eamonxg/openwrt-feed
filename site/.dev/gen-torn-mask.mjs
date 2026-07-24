#!/usr/bin/env node
// Emits the baked torn-edge mask CSS for site/index.html (stdout).
// Not deployed — run with `node gen-torn-mask.mjs`, paste between the
// /* torn-mask:start/end */ markers in the page <style>.
//
// Replaces the live feTurbulence+feDisplacementMap filters that used to shape
// the edge strips. WebKit software-renders reference filters and re-evaluates
// the whole filter whenever any page tile touching the strip rasterizes; with
// the side strips running the full ~3000px sheet, an iPhone could not prepare
// tiles ahead of a fling and the page bottom checkerboarded. Here the same
// silhouettes are baked into tiny inline SVG masks, so at runtime each strip
// is a plain paper rect whose mask composites on the GPU.
//
// Geometry contract with the CSS (all px, relative to the sheet edge, negative
// = outside): the fray layer (::before) tears around a mean line 13px outside
// the side edges / 11px outside the caps, wiggling ±11; the torn layer
// (::after) tears around -6 / -4, wiggling ±7.5 — the same means and scales
// the displacement filters used. Boxes are sized so the whole wiggle fits
// inside (masks, unlike filters, cannot paint outside the border-box), and
// side strips stop 12px short of the corners, hidden under the caps, which
// own the corners and carry ragged short ends of their own.

let seed = 47;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const R = (a, b) => a + rnd() * (b - a);
const F = n => +n.toFixed(1);

/* periodic 1-D fractal value noise in [-1,1]; wavelength/octaves mirror the
   old feTurbulence baseFrequency/numOctaves along the edge in question */
function makeNoise(period, wavelength, octaves) {
  const layers = [];
  let amp = 1, total = 0, n = Math.max(2, Math.round(period / wavelength));
  for (let o = 0; o < octaves; o++) {
    layers.push({ v: Array.from({ length: n }, () => R(-1, 1)), n, amp });
    total += amp; amp *= .55; n *= 2;
  }
  return t => {
    let s = 0;
    for (const { v, n, amp } of layers) {
      const u = ((t / period) * n) % n;
      const i = Math.floor(u), w = (1 - Math.cos(Math.PI * (u - i))) / 2;
      s += (v[i % n] * (1 - w) + v[(i + 1) % n] * w) * amp;
    }
    return s / total;
  };
}

const uri = svg => `url("data:image/svg+xml,${
  svg.replaceAll(' ', '%20').replaceAll('<', '%3C').replaceAll('>', '%3E')}")`;
const svgOf = (w, h, d) =>
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path fill='white' d='${d}'/></svg>`;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const TILE = 512;   // vertical period of the side-strip masks
const CAPW = 560;   // cap design width; mask-size 100% stretches to the sheet

/* one strip layer: mean tear line + wiggle amplitude + noise wavelengths
   (along the caps / along the sides, from the old per-axis baseFrequency) */
const FRAY = { mean: { side: 11, cap: 11 }, amp: 11, wl: { cap: 42, side: 25 }, oct: 5,
               box: { side: 43, cap: 45 } };
const TORN = { mean: { side: 8, cap: 8 }, amp: 7.5, wl: { cap: 77, side: 48 }, oct: 4,
               box: { side: 30, cap: 38 } };

function sideMask(L, right) {
  const { amp, box: { side: W }, mean: { side: mean }, wl, oct } = L;
  const noise = makeNoise(TILE, wl.side, oct);
  const bx = y => clamp(mean + amp * noise(y), .5, W - .5);
  const pts = [];
  for (let y = TILE; y >= 0; y -= 3) {
    const x = bx(Math.min(y, TILE - .001));
    pts.push(`L${F(right ? W - x : x)},${y}`);
  }
  const inner = right ? 0 : W;
  return svgOf(W, TILE, `M${inner},0L${inner},${TILE}${pts.join('')}Z`);
}

function capMask(L, bottom) {
  const { amp, box: { cap: H }, mean, wl, oct } = L;
  const top = makeNoise(CAPW, wl.cap, oct);
  const endL = makeNoise(H * 2, wl.side, oct);
  const endR = makeNoise(H * 2, wl.side, oct);
  const by = x => clamp(mean.cap + amp * top(x), .5, H - .5);
  const ex = (f, y) => clamp(mean.side + amp * f(y), .5, CAPW / 2);
  const p = [];
  const yj0 = by(mean.side), yj1 = by(CAPW - mean.side);
  p.push(`M${F(ex(endL, H))},${H}`);
  for (let y = H - 2; y >= yj0; y -= 2) p.push(`L${F(ex(endL, y))},${F(y)}`);
  for (let x = Math.ceil(ex(endL, yj0)); x <= CAPW - mean.side; x += 4) p.push(`L${x},${F(by(x))}`);
  for (let y = Math.ceil(yj1); y <= H; y += 2) p.push(`L${F(CAPW - ex(endR, y))},${F(y)}`);
  const d = p.join('') + `L${F(CAPW - ex(endR, H))},${H}Z`;
  /* e-b is the vertical mirror; flip the whole path via a transform group */
  return bottom
    ? svgOf(CAPW, H, '').replace(`<path fill='white' d=''/>`,
        `<g transform='translate(0 ${H}) scale(1 -1)'><path fill='white' d='${d}'/></g>`)
    : svgOf(CAPW, H, d);
}

const rules = [];
function emit(sel, inset, dim, mask, tiled) {
  const size = tiled ? `100% ${TILE}px` : '100% 100%';
  const rep = tiled ? 'repeat-y' : 'no-repeat';
  rules.push(`.torn ${sel} { inset: ${inset}; ${dim};
  -webkit-mask-image: ${mask}; mask-image: ${mask};
  -webkit-mask-size: ${size}; mask-size: ${size};
  -webkit-mask-repeat: ${rep}; mask-repeat: ${rep}; }`);
}

for (const [cls, L] of [['before', FRAY], ['after', TORN]]) {
  const out = { before: 24, after: 14 }[cls];           // outer inset of the box
  const capOut = { before: 22, after: 12 }[cls];
  emit(`.e-l::${cls}`, `12px auto 12px -${out}px`, `width: ${L.box.side}px`, uri(sideMask(L, false)), true);
  emit(`.e-r::${cls}`, `12px -${out}px 12px auto`, `width: ${L.box.side}px`, uri(sideMask(L, true)), true);
  emit(`.e-t::${cls}`, `-${capOut}px -${out}px auto`, `height: ${L.box.cap}px`, uri(capMask(L, false)), false);
  emit(`.e-b::${cls}`, `auto -${out}px -${capOut}px`, `height: ${L.box.cap}px`, uri(capMask(L, true)), false);
}

process.stdout.write(rules.join('\n') + '\n');
