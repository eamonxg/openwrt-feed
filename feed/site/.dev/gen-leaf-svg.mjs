#!/usr/bin/env node
// Emits the inline animated-SVG leaf-shadow layer for site/index.html (stdout).
// Not deployed — run with `node gen-leaf-svg.mjs`, paste between the
// <!-- leaf-svg:start/end --> markers (scripts do this automatically).
//
// Same pinnate-frond composition as the approved v4 texture (seed 47).
// Architecture that keeps iOS happy AND animation cheap:
//   · blur lives on SMALL subgroups (≤ MAX_CHUNK blades) — each filter buffer is a
//     few hundred px², far under WebKit's 4096² clamp (the torn-edge lesson);
//   · sway animations live on the PARENTS of the filtered groups — the filter's
//     input never changes, so the blurred result is cached and merely transformed;
//   · two nested wrappers per frond give a two-harmonic pendulum, all pure CSS.

let seed = 47;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const R = (a, b) => a + rnd() * (b - a);
const F = n => +n.toFixed(1);

const MAX_CHUNK = 12;

function frondOps(x0, y0, ang0, segs, step, bladeLen, wmul, droop = .07) {
  const ops = []; let x = x0, y = y0, a = ang0, side = rnd() < .5 ? 1 : -1;
  for (let i = 0; i < segs; i++) {
    x += Math.cos(a) * step; y += Math.sin(a) * step;
    a += (Math.PI / 2 - a) * droop + R(-.05, .05);
    side = -side;
    if (rnd() < .18) continue;
    let ba = a + side * R(.55, 1.15);
    ba += (Math.PI / 2 - ba) * .38;
    const arc = Math.max(0, Math.sin(Math.PI * (i + 1) / segs)) ** .6;
    const bl = bladeLen * (arc * .75 + .35) * R(.75, 1.25);
    ops.push({ x, y, bl, w: bl * R(.035, .058) * wmul, ang: ba, bend: R(-7, 9) });
    if (rnd() < .42) {
      const ba2 = (a + side * R(.2, .5)) + (Math.PI / 2 - a) * .3;
      ops.push({ x: x + R(-6, 6), y: y + R(-4, 8), bl: bl * R(.5, .75), w: bl * .04 * wmul, ang: ba2, bend: R(-6, 8) });
    }
  }
  return ops;
}

/* PHASE 1 — geometry, consuming the rnd stream in exactly the v4 order */
const geo = [];
for (const a of [[-160, -30, .25, 20, 62, 195, 1.7, .015], [300, -70, .35, 20, 60, 200, 1.7, .012],
                 [820, -50, .2, 18, 60, 195, 1.7, .015], [1460, -60, Math.PI - .3, 19, 60, 195, 1.7, .014],
                 [430, 40, 1.25, 9, 48, 175, 1.5, .06], [1120, 10, 1.3, 7, 46, 165, 1.5, .06]])
  geo.push({ depth: 0, hx: a[0], hy: a[1], blades: frondOps(...a) });
for (let i = 0; i < 14; i++) {
  const a = Math.PI / 2 + R(-1.1, 1.1), bl = R(130, 230);
  geo.push({ depth: 0, hx: 0, hy: 0, stray: true,
    blades: [{ x: R(-40, 1340), y: R(-20, 250), bl, w: bl * R(.05, .08), ang: a, bend: R(-8, 10) }] });
}
for (const a of [[70, -60, 1.1, 12, 42, 150, 1.1], [300, -80, .9, 13, 43, 152, 1.1],
                 [395, -45, 1.25, 13, 42, 150, 1.1], [640, -85, .95, 8, 40, 140, 1.05],
                 [905, -60, 1.1, 12, 42, 148, 1.1], [1000, -80, .95, 12, 42, 148, 1.1],
                 [1265, -45, 1.35, 11, 40, 142, 1.05]])
  geo.push({ depth: 1, hx: a[0], hy: a[1], blades: frondOps(...a) });
for (const a of [[160, -50, 1.15, 10, 40, 135, .9], [540, -65, 1.0, 10, 39, 132, .9],
                 [950, -55, 1.2, 10, 39, 132, .9], [1250, 60, Math.PI - .9, 8, 38, 128, .88, .05]])
  geo.push({ depth: 2, hx: a[0], hy: a[1], blades: frondOps(...a) });
geo.push({ depth: 2, hx: -30, hy: 420, blades: frondOps(-30, 420, .5, 12, 46, 138, .88, .025) });
for (const [sx, sy] of [[420, 300], [760, 260], [1130, 380], [300, 560], [180, 820], [640, 180], [980, 150]]) {
  const a = Math.PI / 2 + R(-.9, .9), bl = R(95, 170);
  geo.push({ depth: 2, hx: sx, hy: sy, stray: true,
    blades: [{ x: sx, y: sy, bl, w: bl * R(.035, .05), ang: a, bend: R(-7, 9) }] });
}

/* PHASE 2 — animation parameters (stream position is free from here on) */
// per-depth: [inner sway ±deg, outer sway ±deg, outer drift px]
const SWAY = [[.55, .35, 5], [1.35, .6, 8], [2.1, .8, 10]];
const kf = [];
let kn = 0;
function anim(depth, stray) {
  const [ai, ao, drift] = SWAY[depth];
  const m = stray ? R(1.2, 1.8) : R(.8, 1.2);
  const inner = { n: 'li' + kn, a: F(ai * m * R(.8, 1.2)) };
  const outer = { n: 'lo' + kn, a: F(ao * m * R(.7, 1.2)), d: F(drift * R(.6, 1.2)) };
  kn++;
  kf.push(`@keyframes ${inner.n}{from{transform:rotate(${-inner.a}deg)}to{transform:rotate(${inner.a * F(R(.7, 1.3))}deg)}}`);
  kf.push(`@keyframes ${outer.n}{from{transform:translateX(${-outer.d}px) rotate(${-outer.a}deg)}to{transform:translateX(${outer.d}px) rotate(${outer.a}deg)}}`);
  return {
    inner: `animation:${inner.n} ${F(R(6.5, 11))}s ease-in-out ${F(-R(0, 11))}s infinite alternate`,
    outer: `animation:${outer.n} ${F(R(17, 31))}s ease-in-out ${F(-R(0, 31))}s infinite alternate`,
  };
}

const bladePath = b => {
  const d = `M0,0Q${F(b.bl * .5)},${F(-b.w + b.bend)} ${F(b.bl)},${F(b.bend * 2)}Q${F(b.bl * .5)},${F(b.w * .35 + b.bend)} 0,0Z`;
  return `<path d="${d}" transform="translate(${F(b.x)},${F(b.y)}) rotate(${F(b.ang * 180 / Math.PI)})"/>`;
};

/* The blinds variant is NOT emitted here: its light breathes in ways CSS
   keyframes can't (gap thickness, gradient softness and skew all drift per
   frame), so it lives as a canvas renderer in index.html — see blindsLight. */

const DEPTH = [
  { filter: 'lf-far', opacity: .28 },
  { filter: 'lf-mid', opacity: .46 },
  { filter: 'lf-near', opacity: .62 },
];

const layers = [[], [], []];
for (const f of geo) {
  const hinge = f.stray ? { x: f.blades[0].x, y: f.blades[0].y } : { x: f.hx, y: f.hy };
  const a = anim(f.depth, f.stray);
  const org = `transform-origin:${F(hinge.x)}px ${F(hinge.y)}px`;
  const chunks = [];
  for (let i = 0; i < f.blades.length; i += MAX_CHUNK)
    chunks.push(f.blades.slice(i, i + MAX_CHUNK));
  const inner = chunks.map(c =>
    `<g filter="url(#${DEPTH[f.depth].filter})">${c.map(bladePath).join('')}</g>`).join('');
  layers[f.depth].push(
    `<g style="${org};${a.outer}"><g style="${org};${a.inner}">${inner}</g></g>`);
}

process.stdout.write(`<svg class="leaf-svg" viewBox="0 0 1300 1700" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
<defs>
<filter id="lf-far" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="20"/></filter>
<filter id="lf-mid" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="8"/></filter>
<filter id="lf-near" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.2"/></filter>
<style>${kf.join('')}</style>
</defs>
<g class="lv">
${DEPTH.map((d, i) => `<g fill="#3a4148" opacity="${d.opacity}">${layers[i].join('')}</g>`).join('\n')}
</g>
</svg>
`);
