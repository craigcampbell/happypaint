// Pigment-style (Kubelka-Munk) colour mixing.
//
// Mixing two sRGB colours the way paint mixes instead of the way light adds:
// yellow + blue -> green, red + blue -> plum/purple, white lightens without
// greying, complementary pairs go muddy brown/olive rather than neutral grey.
//
// The algorithm and the reflectance / colour-matching data tables below are
// taken from spectral.js v3.0.0 by Ronald van Wijnen
// (https://github.com/rvanwijnen/spectral.js, npm package "spectral.js"),
// which is published under the MIT licence (verified against the LICENSE file
// shipped in the npm package, copyright (c) 2025 Ronald van Wijnen). The code
// itself has been rewritten around preallocated typed arrays for a
// zero-allocation per-dab hot path; the maths is unchanged.
//
//  MIT License
//
//  Copyright (c) 2025 Ronald van Wijnen
//
//  Permission is hereby granted, free of charge, to any person obtaining a
//  copy of this software and associated documentation files (the "Software"),
//  to deal in the Software without restriction, including without limitation
//  the rights to use, copy, modify, merge, publish, distribute, sublicense,
//  and/or sell copies of the Software, and to permit persons to whom the
//  Software is furnished to do so, subject to the following conditions:
//
//  The above copyright notice and this permission notice shall be included in
//  all copies or substantial portions of the Software.
//
//  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//  FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//  DEALINGS IN THE SOFTWARE.
//
// ---------------------------------------------------------------------------
// How it works (per mix):
//
//   1. sRGB (0-255)  ->  linear RGB (0-1)            (inverse sRGB companding)
//   2. linear RGB    ->  7 pigment weights           (white, cyan, magenta,
//                                                     yellow, red, green, blue)
//   3. weights       ->  reflectance R(lambda)       (38 bands, 380-750 nm,
//                                                     R = sum_i w_i * basis_i)
//   4. reflectance   ->  K/S(lambda) = (1-R)^2 / 2R  (Kubelka-Munk: the ratio of
//                                                     absorption to scattering
//                                                     that IS linear in pigment
//                                                     concentration)
//   5. K/S_mix = (c_a * K/S_a + c_b * K/S_b) / (c_a + c_b)
//        with concentration c_a = (1-t)^2 * Y_a and c_b = t^2 * Y_b
//        (Y = luminance). The luminance weighting is spectral.js's tinting-
//        strength model: it stops dark, high-K/S colours from swamping light
//        ones so that white + colour reads as a tint and t behaves like a
//        perceptual share rather than a pigment-mass share.
//   6. K/S -> R:  R = 1 + K/S - sqrt(K/S^2 + 2 K/S)    (exact inverse of 4)
//   7. R -> XYZ via the CIE 1931 2-degree colour-matching functions weighted
//      by the D65 illuminant, XYZ -> linear sRGB (matrix), clamp to gamut,
//      sRGB companding, round to 0-255.
//
// Everything is pure and deterministic (no Math.random / Date), every hot-path
// buffer is preallocated at module level, and all inputs are sanitised so
// NaN / out-of-range / non-numeric channels can never produce NaN output.
// ---------------------------------------------------------------------------

/** Number of spectral bands (380 nm to 750 nm in 10 nm steps). */
export const SIZE = 38;

/**
 * Layout of a latent vector (see rgbToLatent):
 *   [0, SIZE)          reflectance R per band
 *   [SIZE, 2*SIZE)     K/S per band (kept alongside R so repeated mixes never
 *                      have to re-derive one from the other)
 *   [2*SIZE]           luminance Y (the K-M concentration weight)
 */
export const LATENT_SIZE = SIZE * 2 + 1;
const KS_OFF = SIZE;
const Y_OFF = SIZE * 2;

const GAMMA = 2.4;

// Reflectance floor. spectral.js uses Number.EPSILON; anything small works
// because the luminance weighting cancels the 1/R blow-up of K/S to first
// order (Y * K/S ~ 1/2 for a flat dark spectrum). 1e-6 keeps K/S <= 5e5 so the
// weighted sums stay comfortably inside double precision.
const R_MIN = 1e-6;

// --- Data tables (spectral.js v3.0.0, verbatim) ---------------------------

// Base reflectance spectra for the seven "pigments" the linear RGB cube is
// decomposed into: White, Cyan, Magenta, Yellow, Red, Green, Blue.
const BASE_W = [
  1.00116072718764, 1.00116065159728, 1.00116031922747, 1.00115867270789, 1.00115259844552, 1.00113252528998, 1.00108500663327, 1.00099687889453, 1.00086525152274,
  1.0006962900094, 1.00050496114888, 1.00030808187992, 1.00011966602013, 0.999952765968407, 0.999821836899297, 0.999738609557593, 0.999709551639612, 0.999731930210627,
  0.999799436346195, 0.999900330316671, 1.00002040652611, 1.00014478793658, 1.00025997903412, 1.00035579697089, 1.00042753780269, 1.00047623344888, 1.00050720967508,
  1.00052519156373, 1.00053509606896, 1.00054022097482, 1.00054272816784, 1.00054389569087, 1.00054448212151, 1.00054476959992, 1.00054489887762, 1.00054496254689,
  1.00054498927058, 1.000544996993,
];
const BASE_C = [
  0.970585001322962, 0.970592498143425, 0.970625348729891, 0.970786806119017, 0.971368673228248, 0.973163230621252, 0.976740223158765, 0.981587605491377, 0.986280265652949,
  0.989949147689134, 0.99249270153842, 0.994145680405256, 0.995183975033212, 0.995756750110818, 0.99591281828671, 0.995606157834528, 0.994597600961854, 0.99221571549237,
  0.986236452783249, 0.967943337264541, 0.891285004244943, 0.536202477862053, 0.154108119001878, 0.0574575093228929, 0.0315349873107007, 0.0222633920086335, 0.0182022841492439,
  0.016299055973264, 0.0153656239334613, 0.0149111568733976, 0.0146954339898235, 0.0145964146717719, 0.0145470156699655, 0.0145228771899495, 0.0145120341118965,
  0.0145066940939832, 0.0145044507314479, 0.0145038009464639,
];
const BASE_M = [
  0.990673557319988, 0.990671524961979, 0.990662582353421, 0.990618107644795, 0.99045148087871, 0.989871081400204, 0.98828660875964, 0.984290692797504, 0.973934905625306,
  0.941817838460145, 0.817390326195156, 0.432472805065729, 0.13845397825887, 0.0537347216940033, 0.0292174996673231, 0.021313651750859, 0.0201349530181136, 0.0241323096280662,
  0.0372236145223627, 0.0760506552706601, 0.205375471942399, 0.541268903460439, 0.815841685086486, 0.912817704123976, 0.946339830166962, 0.959927696331991, 0.966260595230312,
  0.969325970058424, 0.970854536721399, 0.971605066528128, 0.971962769757392, 0.972127272274509, 0.972209417745812, 0.972249577678424, 0.972267621998742, 0.97227650946215,
  0.972280243306874, 0.97228132482656,
];
const BASE_Y = [
  0.0210523371789306, 0.0210564627517414, 0.0210746178695038, 0.0211649058448753, 0.0215027957272504, 0.0226738799041561, 0.0258235649693629, 0.0334879385639851,
  0.0519069663740307, 0.100749014833473, 0.239129899706847, 0.534804312272748, 0.79780757864303, 0.911449894067384, 0.953797963004507, 0.971241615465429, 0.979303123807588,
  0.983380119507575, 0.985461246567755, 0.986435046976605, 0.986738250670141, 0.986617882445032, 0.986277776758643, 0.985860592444056, 0.98547492767621, 0.985176934765558,
  0.984971574014181, 0.984846303415712, 0.984775351811199, 0.984738066625265, 0.984719648311765, 0.984711023391939, 0.984706683300676, 0.984704554393091, 0.98470359630937,
  0.984703124077552, 0.98470292561509, 0.984702868122795,
];
const BASE_R = [
  0.0315605737777207, 0.0315520718330149, 0.0315148215513658, 0.0313318044982702, 0.0306729857725527, 0.0286480476989607, 0.0246450407045709, 0.0192960753663651,
  0.0142066612220556, 0.0102942608878609, 0.0076191460521811, 0.005898041083542, 0.0048233247781713, 0.0042298748350633, 0.0040599171299341, 0.0043533695594676,
  0.0053434425970201, 0.0076917201010463, 0.0135969795736536, 0.0316975442661115, 0.107861196355249, 0.463812603168704, 0.847055405272011, 0.943185409393918, 0.968862150696558,
  0.978030667473603, 0.982043643854306, 0.983923623718707, 0.984845484154382, 0.985294275814596, 0.985507295219825, 0.985605071539837, 0.985653849933578, 0.985677685033883,
  0.985688391806122, 0.985693664690031, 0.985695879848205, 0.985696521463762,
];
const BASE_G = [
  0.0095560747554212, 0.0095581580120851, 0.0095673245444588, 0.0096129126297349, 0.0097837090401843, 0.010378622705871, 0.0120026452378567, 0.0160977721473922,
  0.026706190223168, 0.0595555440185881, 0.186039826532826, 0.570579820116159, 0.861467768400292, 0.945879089767658, 0.970465486474305, 0.97841363028445, 0.979589031411224,
  0.975533536908632, 0.962288755397813, 0.92312157451312, 0.793434018943111, 0.459270135902429, 0.185574103666303, 0.0881774959955372, 0.05436302287667, 0.0406288447060719,
  0.034221520431697, 0.0311185790956966, 0.0295708898336134, 0.0288108739348928, 0.0284486271324597, 0.0282820301724731, 0.0281988376490237, 0.0281581655342037,
  0.0281398910216386, 0.0281308901665811, 0.0281271086805816, 0.0281260133612096,
];
const BASE_B = [
  0.979404752502014, 0.97940070684313, 0.979382903470261, 0.979294364945594, 0.97896301460857, 0.977814466694043, 0.974724321133836, 0.967198482343973, 0.949079657530575,
  0.900850128940977, 0.76315044546224, 0.465922171649319, 0.201263280451005, 0.0877524413419623, 0.0457176793291679, 0.0284706050521843, 0.020527176756985, 0.0165302792310211,
  0.0145135107212858, 0.0136003508637687, 0.0133604258769571, 0.013548894314568, 0.0139594356366992, 0.014443425575357, 0.0148854440621406, 0.0152254296999746,
  0.0154592848180209, 0.0156018026485961, 0.0156824871281936, 0.0157248764360615, 0.0157458108784121, 0.0157556123350225, 0.0157605443964911, 0.0157629637515278,
  0.0157640525629106, 0.015764589232951, 0.0157648147772649, 0.0157648801149616,
];

// CIE 1931 2-degree colour-matching functions weighted by the D65 illuminant
// and normalised so that a flat R = 1 spectrum gives Y = 1 (x-bar, y-bar, z-bar).
const CMF_X = [
  0.0000646919989576, 0.0002194098998132, 0.0011205743509343, 0.0037666134117111, 0.011880553603799, 0.0232864424191771, 0.0345594181969747, 0.0372237901162006,
  0.0324183761091486, 0.021233205609381, 0.0104909907685421, 0.0032958375797931, 0.0005070351633801, 0.0009486742057141, 0.0062737180998318, 0.0168646241897775,
  0.028689649025981, 0.0426748124691731, 0.0562547481311377, 0.0694703972677158, 0.0830531516998291, 0.0861260963002257, 0.0904661376847769, 0.0850038650591277,
  0.0709066691074488, 0.0506288916373645, 0.035473961885264, 0.0214682102597065, 0.0125164567619117, 0.0068045816390165, 0.0034645657946526, 0.0014976097506959,
  0.000769700480928, 0.0004073680581315, 0.0001690104031614, 0.0000952245150365, 0.0000490309872958, 0.0000199961492222,
];
const CMF_Y = [
  0.000001844289444, 0.0000062053235865, 0.0000310096046799, 0.0001047483849269, 0.0003536405299538, 0.0009514714056444, 0.0022822631748318, 0.004207329043473,
  0.0066887983719014, 0.0098883960193565, 0.0152494514496311, 0.0214183109449723, 0.0334229301575068, 0.0513100134918512, 0.070402083939949, 0.0878387072603517,
  0.0942490536184085, 0.0979566702718931, 0.0941521856862608, 0.0867810237486753, 0.0788565338632013, 0.0635267026203555, 0.05374141675682, 0.042646064357412,
  0.0316173492792708, 0.020885205921391, 0.0138601101360152, 0.0081026402038399, 0.004630102258803, 0.0024913800051319, 0.0012593033677378, 0.000541646522168,
  0.0002779528920067, 0.0001471080673854, 0.0000610327472927, 0.0000343873229523, 0.0000177059860053, 0.000007220974913,
];
const CMF_Z = [
  0.000305017147638, 0.0010368066663574, 0.0053131363323992, 0.0179543925899536, 0.0570775815345485, 0.113651618936287, 0.17335872618355, 0.196206575558657,
  0.186082370706296, 0.139950475383207, 0.0891745294268649, 0.0478962113517075, 0.0281456253957952, 0.0161376622950514, 0.0077591019215214, 0.0042961483736618,
  0.0020055092122156, 0.0008614711098802, 0.0003690387177652, 0.0001914287288574, 0.0001495555858975, 0.0000923109285104, 0.0000681349182337, 0.0000288263655696,
  0.0000157671820553, 0.0000039406041027, 0.000001584012587, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];

// XYZ (D65) -> linear sRGB.
const XYZ_RGB = [
  3.2409699419045226, -1.537383177570094, -0.4986107602930034,
  -0.9692436362808796, 1.8759675015077202, 0.04155505740717559,
  0.05563007969699366, -0.20397695888897652, 1.0569715142428786,
];

// --- Packed, band-major typed-array copies of the tables --------------------
// BASIS[i*7 + k]: reflectance of pigment k (W,C,M,Y,R,G,B order) in band i.
// CMF[i*3 + k]:   x-bar / y-bar / z-bar in band i.
// Band-major layout keeps the inner loops streaming through memory once.

const BASIS = new Float64Array(SIZE * 7);
const CMF = new Float64Array(SIZE * 3);
for (let i = 0; i < SIZE; i++) {
  const o = i * 7;
  BASIS[o] = BASE_W[i];
  BASIS[o + 1] = BASE_C[i];
  BASIS[o + 2] = BASE_M[i];
  BASIS[o + 3] = BASE_Y[i];
  BASIS[o + 4] = BASE_R[i];
  BASIS[o + 5] = BASE_G[i];
  BASIS[o + 6] = BASE_B[i];
  CMF[i * 3] = CMF_X[i];
  CMF[i * 3 + 1] = CMF_Y[i];
  CMF[i * 3 + 2] = CMF_Z[i];
}

// sRGB -> linear lookup for the 256 integer inputs (the overwhelmingly common
// case); non-integer channels fall back to the closed-form curve.
const LINEAR_LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) LINEAR_LUT[i] = uncompand(i / 255);

// --- Scalar helpers ---------------------------------------------------------

/** sRGB companded value in [0,1] -> linear light. */
function uncompand(x) {
  return x > 0.04045 ? Math.pow((x + 0.055) / 1.055, GAMMA) : x / 12.92;
}

/** Linear light in [0,1] -> sRGB companded value in [0,1]. */
function compand(x) {
  return x > 0.0031308 ? 1.055 * Math.pow(x, 1 / GAMMA) - 0.055 : x * 12.92;
}

/**
 * Coerce a channel to a finite number in [0, 255]. NaN, undefined, strings
 * that do not parse, Infinity, negatives and > 255 all land inside the range
 * (NaN -> 0), so nothing downstream can see a NaN.
 */
function sanitizeChannel(x) {
  x = +x;
  // `x >= 0` is false for NaN, which routes NaN to 0.
  return x >= 0 ? (x <= 255 ? x : 255) : 0;
}

/** Coerce a mix weight to [0, 1]; NaN -> 0 (i.e. "all of a"). */
function sanitizeT(t) {
  t = +t;
  return t > 0 ? (t < 1 ? t : 1) : 0;
}

/** Integer sRGB channel from a linear-light value, clamped to gamut. */
function linearToByte(x) {
  if (!(x > 0)) return 0; // also catches NaN
  if (x >= 1) return 255;
  return Math.round(compand(x) * 255);
}

/** Channel 0..255 (already sanitised) -> linear light. */
function channelToLinear(x) {
  const xi = x | 0;
  return xi === x ? LINEAR_LUT[xi] : uncompand(x / 255);
}

// --- Latent representation ----------------------------------------------------

/**
 * Decompose an sRGB colour into its Kubelka-Munk latent vector.
 *
 * Cost: 3 sRGB->linear conversions, the 7-weight decomposition, and one pass
 * over 38 bands doing 7 multiply-adds + one division (K/S) + one multiply-add
 * (luminance) each: roughly 400 flops. This is the expensive half of a mix, so
 * a renderer that keeps a carried colour should hold it as a latent (see
 * mixLatent) and only decompose the brush colour once per stroke.
 *
 * @param {number} r 0-255 (floats allowed; anything else is sanitised)
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @param {Float64Array|number[]} [out] buffer of length >= LATENT_SIZE
 * @returns {Float64Array|number[]} `out` (or a new Float64Array)
 */
export function rgbToLatent(r, g, b, out) {
  if (!out || out.length < LATENT_SIZE) out = new Float64Array(LATENT_SIZE);
  const lr = channelToLinear(sanitizeChannel(r));
  const lg = channelToLinear(sanitizeChannel(g));
  const lb = channelToLinear(sanitizeChannel(b));
  decomposeLinear(lr, lg, lb, out);
  return out;
}

/**
 * Linear RGB -> latent. The linear RGB cube is split into a white component
 * (the common minimum), then either a subtractive primary (C/M/Y, the second
 * minimum) and the leftover additive primary (R/G/B). Exactly three of the
 * seven weights can be non-zero for any input, and the basis spectra were fitted
 * so that the resulting reflectance reproduces the input colour under D65.
 */
function decomposeLinear(lr, lg, lb, out) {
  // White = the part shared by all three channels.
  const w = lr < lg ? (lr < lb ? lr : lb) : lg < lb ? lg : lb;
  lr -= w;
  lg -= w;
  lb -= w;
  // Subtractive primaries: the overlap of two channels.
  const c = lg < lb ? lg : lb;
  const m = lr < lb ? lr : lb;
  const y = lr < lg ? lr : lg;
  // Additive primaries: what one channel has over both others.
  let pr = lr - lb < lr - lg ? lr - lb : lr - lg;
  let pg = lg - lb < lg - lr ? lg - lb : lg - lr;
  let pb = lb - lg < lb - lr ? lb - lg : lb - lr;
  if (pr < 0) pr = 0;
  if (pg < 0) pg = 0;
  if (pb < 0) pb = 0;

  let Y = 0;
  for (let i = 0, o = 0; i < SIZE; i++, o += 7) {
    let R =
      w * BASIS[o] +
      c * BASIS[o + 1] +
      m * BASIS[o + 2] +
      y * BASIS[o + 3] +
      pr * BASIS[o + 4] +
      pg * BASIS[o + 5] +
      pb * BASIS[o + 6];
    if (!(R > R_MIN)) R = R_MIN; // floor (and NaN guard: NaN > x is false)
    out[i] = R;
    // Kubelka-Munk: K/S = (1 - R)^2 / (2 R). Linear in pigment concentration.
    const oneMinus = 1 - R;
    out[KS_OFF + i] = (oneMinus * oneMinus) / (2 * R);
    Y += CMF[i * 3 + 1] * R;
  }
  out[Y_OFF] = Y > R_MIN ? Y : R_MIN;
}

/**
 * Mix two latents in K/S space, writing a new latent.
 *
 * Cost: one pass over 38 bands with 2 multiply-adds, one sqrt (K/S -> R) and
 * one multiply-add (luminance): roughly 200 flops. Chaining is safe: the
 * output is a complete latent and can be fed straight back in as `a` or `b`
 * (mixing into itself via `out === a` is also fine, every band is read before
 * it is written).
 *
 * @param {Float64Array|number[]} a latent from rgbToLatent / mixLatent
 * @param {Float64Array|number[]} b latent
 * @param {number} t weight of `b`, 0..1
 * @param {Float64Array|number[]} [out] buffer of length >= LATENT_SIZE
 * @returns {Float64Array|number[]} `out` (or a new Float64Array)
 */
export function mixLatent(a, b, t, out) {
  if (!out || out.length < LATENT_SIZE) out = new Float64Array(LATENT_SIZE);
  t = sanitizeT(t);
  // Concentrations: the square of the share times the colour's luminance
  // (spectral.js's tinting-strength model). The luminance term is what keeps
  // a light colour from being swallowed by a dark one's huge K/S.
  const ta = 1 - t;
  let ca = ta * ta * a[Y_OFF];
  let cb = t * t * b[Y_OFF];
  if (!(ca >= 0)) ca = 0;
  if (!(cb >= 0)) cb = 0;
  let total = ca + cb;
  if (!(total > 0)) {
    // Degenerate (both concentrations zero or non-finite): fall back to a
    // plain share so we still return something sensible and NaN-free.
    ca = ta;
    cb = t;
    total = 1;
  }
  const wa = ca / total;
  const wb = cb / total;

  let Y = 0;
  for (let i = 0; i < SIZE; i++) {
    let ks = wa * a[KS_OFF + i] + wb * b[KS_OFF + i];
    if (!(ks >= 0)) ks = 0;
    // Inverse Kubelka-Munk: R = 1 + K/S - sqrt(K/S^2 + 2 K/S).
    let R = 1 + ks - Math.sqrt(ks * ks + 2 * ks);
    if (!(R > R_MIN)) R = R_MIN;
    out[i] = R;
    out[KS_OFF + i] = ks;
    Y += CMF[i * 3 + 1] * R;
  }
  out[Y_OFF] = Y > R_MIN ? Y : R_MIN;
  return out;
}

/**
 * Latent -> integer sRGB.
 *
 * Cost: one pass over 38 bands with 3 multiply-adds (reflectance -> XYZ), a
 * 3x3 matrix, clamp, and 3 companding pows: roughly 130 flops.
 *
 * @param {Float64Array|number[]} latent
 * @param {number[]|Float64Array} [out] length-3 buffer
 * @returns {number[]|Float64Array} `out` (or a new plain array) as [r, g, b] ints
 */
export function latentToRgb(latent, out) {
  if (!out) out = [0, 0, 0];
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
    const R = latent[i];
    X += CMF[o] * R;
    Y += CMF[o + 1] * R;
    Z += CMF[o + 2] * R;
  }
  const lr = XYZ_RGB[0] * X + XYZ_RGB[1] * Y + XYZ_RGB[2] * Z;
  const lg = XYZ_RGB[3] * X + XYZ_RGB[4] * Y + XYZ_RGB[5] * Z;
  const lb = XYZ_RGB[6] * X + XYZ_RGB[7] * Y + XYZ_RGB[8] * Z;
  // Mixes of saturated colours can land slightly outside the sRGB gamut
  // (e.g. white + red); a plain clamp is the cheap, deterministic choice here.
  out[0] = linearToByte(lr);
  out[1] = linearToByte(lg);
  out[2] = linearToByte(lb);
  return out;
}

// --- Hot path: mixRgbFloat -------------------------------------------------------

// Module-level scratch: two cached input latents plus the mix output. Nothing
// in mixRgbFloat allocates.
const SLOT_LAT = [new Float64Array(LATENT_SIZE), new Float64Array(LATENT_SIZE)];
const SLOT_KEY = new Float64Array(6); // [r0,g0,b0, r1,g1,b1]
const SLOT_VALID = [false, false];
const MIX_LAT = new Float64Array(LATENT_SIZE);

/**
 * Find (or build) the latent for a sanitised colour in the two-slot cache.
 * `fillSlot` is where a miss is decomposed to; the caller passes the slot the
 * other operand is NOT using so the two operands never evict each other.
 * The typical stroke mixes a varying carried colour against one fixed brush
 * colour, so the brush colour stays cached and only one decomposition runs
 * per call.
 */
function resolveSlot(r, g, b, fillSlot) {
  if (SLOT_VALID[0] && SLOT_KEY[0] === r && SLOT_KEY[1] === g && SLOT_KEY[2] === b) return 0;
  if (SLOT_VALID[1] && SLOT_KEY[3] === r && SLOT_KEY[4] === g && SLOT_KEY[5] === b) return 1;
  decomposeLinear(channelToLinear(r), channelToLinear(g), channelToLinear(b), SLOT_LAT[fillSlot]);
  const k = fillSlot * 3;
  SLOT_KEY[k] = r;
  SLOT_KEY[k + 1] = g;
  SLOT_KEY[k + 2] = b;
  SLOT_VALID[fillSlot] = true;
  return fillSlot;
}

/**
 * Zero-allocation pigment mix for the draw hot path.
 *
 * @param {number} ar red of a, 0-255 (floats allowed)
 * @param {number} ag
 * @param {number} ab
 * @param {number} br red of b, 0-255
 * @param {number} bg
 * @param {number} bb
 * @param {number} t weight of b in 0..1 (t=0 -> a exactly, t=1 -> b exactly)
 * @param {Float64Array|number[]} out length-3 buffer to write [r, g, b] ints into.
 *   Pass one from the caller to keep this allocation-free; if omitted a plain
 *   array is created.
 * @returns {Float64Array|number[]} `out`
 */
export function mixRgbFloat(ar, ag, ab, br, bg, bb, t, out) {
  if (!out) out = [0, 0, 0];
  ar = sanitizeChannel(ar);
  ag = sanitizeChannel(ag);
  ab = sanitizeChannel(ab);
  br = sanitizeChannel(br);
  bg = sanitizeChannel(bg);
  bb = sanitizeChannel(bb);
  t = sanitizeT(t);

  // Endpoints and identical inputs are returned exactly (rounded to ints)
  // without touching the spectral pipeline: the basis round-trip is verified
  // exact on a coarse grid but we do not rely on that for the guarantees.
  if (t === 0 || (ar === br && ag === bg && ab === bb)) {
    out[0] = Math.round(ar);
    out[1] = Math.round(ag);
    out[2] = Math.round(ab);
    return out;
  }
  if (t === 1) {
    out[0] = Math.round(br);
    out[1] = Math.round(bg);
    out[2] = Math.round(bb);
    return out;
  }

  const sa = resolveSlot(ar, ag, ab, 0);
  const sb = resolveSlot(br, bg, bb, sa === 0 ? 1 : 0);
  mixLatent(SLOT_LAT[sa], SLOT_LAT[sb], t, MIX_LAT);
  return latentToRgb(MIX_LAT, out);
}

/**
 * Convenience wrapper over mixRgbFloat for [r, g, b] triples.
 *
 * @param {number[]} a [r, g, b] 0-255 ints
 * @param {number[]} b [r, g, b] 0-255 ints
 * @param {number} t weight of b in 0..1
 * @param {number[]} [out] optional length-3 buffer
 * @returns {number[]} [r, g, b] ints; t=0 gives a, t=1 gives b, a===b gives a
 */
export function mixRgb(a, b, t, out) {
  const ar = a ? a[0] : 0;
  const ag = a ? a[1] : 0;
  const ab = a ? a[2] : 0;
  const br = b ? b[0] : 0;
  const bg = b ? b[1] : 0;
  const bb = b ? b[2] : 0;
  return mixRgbFloat(ar, ag, ab, br, bg, bb, t, out || [0, 0, 0]);
}
