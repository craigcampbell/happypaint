// Builds src/data/world-geo.json: true lon/lat country polygons for the
// spherical Painted Planet globe.
//
// Source (public domain): Natural Earth 1:110m admin-0 countries GeoJSON,
//   https://github.com/nvkelso/natural-earth-vector (geojson/ne_110m_admin_0_countries.geojson)
//   Natural Earth data is free of copyright (public domain) — see
//   https://www.naturalearthdata.com/about/terms-of-use/
// ISO alpha-2 codes use ISO_A2_EH (the "earshot" code Natural Earth keeps
//   filled where ISO_A2 is -99). Country *names* are the curated set already
//   shipped in src/data/world-paths.json so the globe, the server flag names
//   and the flag rooms never disagree.
// Tiny nations too small to have a 110m polygon keep a lon/lat centroid (see
//   DOT_CENTROIDS below — approximate territory centres, degrees).
//
// Usage:  node scripts/planet-globe-data.mjs [path-to-ne110.geojson]
// (fetches the GeoJSON when no path is given; needs network once)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const WORLD_PATHS = join(ROOT, "src", "data", "world-paths.json");
const OUT = join(ROOT, "src", "data", "world-geo.json");

// Approximate territory centroids [lon, lat] for the nations too small for a
// 110m polygon (kept as paint dabs on the globe, exactly like world-paths.json).
const DOT_CENTROIDS = {
  AD: [1.6, 42.55], AG: [-61.8, 17.08], AI: [-63.07, 18.22], AS: [-170.7, -14.3],
  AW: [-69.97, 12.52], AX: [19.9, 60.2], BB: [-59.55, 13.17], BH: [50.55, 26.07],
  BL: [-62.83, 17.9], BM: [-64.75, 32.31], BQ: [-68.27, 12.15], CC: [96.84, -12.16],
  CK: [-159.78, -21.23], CV: [-23.6, 15.11], CW: [-68.93, 12.17], CX: [105.69, -10.49],
  DM: [-61.37, 15.42], FM: [158.22, 6.89], FO: [-6.9, 61.97], GD: [-61.68, 12.12],
  GF: [-53.0, 3.9], GG: [-2.58, 49.45], GI: [-5.35, 36.14], GP: [-61.58, 16.25],
  GS: [-36.5, -54.4], GU: [144.79, 13.44], HK: [114.16, 22.32], HM: [73.5, -53.1],
  IM: [-4.55, 54.23], IO: [72.42, -7.32], JE: [-2.13, 49.21], KI: [173.0, 1.45],
  KM: [43.33, -11.65], KN: [-62.73, 17.32], KY: [-81.25, 19.31], LC: [-60.97, 13.91],
  LI: [9.55, 47.14], MC: [7.42, 43.74], MF: [-63.05, 18.08], MH: [171.18, 7.09],
  MO: [113.55, 22.19], MP: [145.67, 15.18], MQ: [-61.02, 14.65], MS: [-62.19, 16.74],
  MT: [14.42, 35.89], MU: [57.55, -20.28], MV: [73.4, 3.2], NF: [167.95, -29.03],
  NR: [166.92, -0.52], NU: [-169.87, -19.05], PF: [-149.4, -17.68], PM: [-56.32, 46.83],
  PN: [-130.1, -25.07], PW: [134.58, 7.51], RE: [55.54, -21.13], SC: [55.45, -4.68],
  SG: [103.82, 1.35], SH: [-5.7, -15.96], SJ: [18.0, 78.6], SM: [12.46, 43.94],
  ST: [6.61, 0.19], SX: [-63.05, 18.04], TC: [-71.8, 21.79], TK: [-171.83, -9.2],
  TO: [-175.2, -21.18], TV: [179.2, -8.52], VA: [12.45, 41.9], VC: [-61.2, 13.25],
  VG: [-64.62, 18.42], VI: [-64.93, 18.34], WF: [-178.12, -14.29], WS: [-172.13, -13.76],
  YT: [45.16, -12.83],
};

const round1 = (v) => Math.round(v * 10) / 10;

// Quantize + drop consecutive dupes + unwrap the antimeridian so no ring edge
// ever jumps more than 180° (Fiji/Russia stay continuous).
function cleanRing(ring) {
  const out = [];
  let prevLon = null;
  for (const [lon0, lat0] of ring) {
    let lon = round1(lon0);
    const lat = Math.max(-90, Math.min(90, round1(lat0)));
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    const last = out[out.length - 1];
    if (!last || last[0] !== lon || last[1] !== lat) out.push([lon, lat]);
    prevLon = lon;
  }
  // drop closing duplicate of the first point
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function ringArea2(r) { // signed shoelace in deg² — only used to rank rings
  let a = 0;
  for (let i = 0; i < r.length; i += 1) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % r.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function ringCenter(r) {
  let sx = 0; let sy = 0;
  for (const [x, y] of r) { sx += x; sy += y; }
  return [round1(sx / r.length), round1(sy / r.length)];
}

async function main() {
  let geojson;
  if (process.argv[2]) {
    geojson = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } else {
    const res = await fetch(SRC_URL);
    if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
    geojson = await res.json();
  }
  const wp = JSON.parse(readFileSync(WORLD_PATHS, "utf8"));
  const byCode = new Map();
  for (const f of geojson.features) {
    const code = f.properties.ISO_A2_EH || f.properties.ISO_A2;
    if (code && code !== "-99") byCode.set(code, f);
  }

  const countries = [];
  for (const c of wp.countries) {
    const f = byCode.get(c.code);
    if (!f) throw new Error(`no Natural Earth geometry for ${c.code}`);
    const geom = f.geometry;
    const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
    const rings = [];
    for (const poly of polys) {
      const outer = cleanRing(poly[0]);
      if (outer.length < 4) continue;
      rings.push(outer);
    }
    rings.sort((a, b) => ringArea2(b) - ringArea2(a));
    if (!rings.length) throw new Error(`no usable rings for ${c.code}`);
    countries.push({ code: c.code, c: ringCenter(rings[0]), rings });
  }

  const dots = [];
  for (const d of wp.dots) {
    const f = byCode.get(d.code);
    if (f) {
      // it exists at 110m after all (e.g. AQ): centroid of its largest ring
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      const rings = polys.map((p) => cleanRing(p[0])).filter((r) => r.length >= 4);
      rings.sort((a, b) => ringArea2(b) - ringArea2(a));
      dots.push({ code: d.code, c: ringCenter(rings[0]) });
      continue;
    }
    const c = DOT_CENTROIDS[d.code];
    if (!c) throw new Error(`no centroid for tiny nation ${d.code}`);
    dots.push({ code: d.code, c });
  }

  const out = {
    source: "Natural Earth 1:110m admin-0 countries (public domain — naturalearthdata.com), via github.com/nvkelso/natural-earth-vector geojson; lon/lat degrees, 0.1° quantised, antimeridian-unwrapped. Tiny-nation centroids approximate. Built by scripts/planet-globe-data.mjs.",
    names: wp.names,
    countries,
    dots,
  };
  writeFileSync(OUT, JSON.stringify(out));
  const pts = countries.reduce((s, c) => s + c.rings.reduce((n, r) => n + r.length, 0), 0);
  console.log(`wrote ${OUT}: ${countries.length} countries (${pts} pts), ${dots.length} dots, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
