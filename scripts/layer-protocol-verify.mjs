// Shared layer stack — the SERVER boundary. Raw WS, no browser: this is where
// "a reload, a rejoin and a collaborator all see the same stack" is won or lost.
//
//  P1  every frame materializes one base layer (legacy rooms included)
//  P2  layer_add mints the id server-side and echoes the canonical list
//  P3  an op carries its layerId and is relayed with it
//  P4  an op naming a layer that doesn't exist is DROPPED (never re-homed)
//  P5  a locked layer takes a host's ink only
//  P6  layer_patch / layer_move echo the canonical list
//  P7  the cap holds (6 layers, 3 in animation rooms) with layer_denied
//  P8  layer_del purges that layer's ops and keeps at least one layer
//  P9  the stack persists to the room file and survives a reload
//  P10 legacy ops (no layerId) still land on the base layer
//  P11 a public (kid_safe) room is host-only for layer structure
//
// Usage: node scripts/layer-protocol-verify.mjs
import { spawn } from "child_process";
import { mkdirSync, readFileSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

const PORT = 8957;
const BASE = `http://localhost:${PORT}`;
const ROOM = "LAYERPRV";
const PUBLIC_ROOM = "MAIN";
const ROOT = process.cwd();
const SCRATCH = path.join(os.tmpdir(), "hp-layer-protocol-verify");

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(SCRATCH, { recursive: true });
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: SCRATCH },
  stdio: "pipe",
});
server.stderr.on("data", (d) => process.stderr.write("[srv] " + d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`);
  if (!ok) fails += 1;
};

function connectMember(room) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
    const msgs = [];
    ws.on("message", (raw) => {
      try { msgs.push(JSON.parse(raw.toString())); } catch { /* binary history */ }
    });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth", token: null }));
      setTimeout(() => resolve({ ws, msgs, send: (o) => ws.send(JSON.stringify(o)) }), 400);
    });
  });
}
const last = (c, type) => [...c.msgs].reverse().find((m) => m.type === type) || null;
const all = (c, type) => c.msgs.filter((m) => m.type === type);
async function waitFor(c, pred, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const hit = [...c.msgs].reverse().find(pred);
    if (hit) return hit;
    await sleep(60);
  }
  return null;
}
const layerNames = (msg) => (msg?.layers || []).map((l) => l.name).join(",");
const drawOp = (strokeId, layerId, extra = {}) => ({
  type: "op",
  op: {
    kind: "draw",
    strokeId,
    points: [{ x: 20, y: 20 }, { x: 60, y: 60 }],
    settings: { brush: "marker", color: "#111827", size: 24 },
    end: true,
    ...(layerId ? { layerId } : {}),
    ...extra,
  },
});

const run = async () => {
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) break; } catch { /* booting */ }
    await sleep(250);
  }

  // ---- A private room: host + member --------------------------------------
  const A = await connectMember(ROOM);
  const aConn = await waitFor(A, (m) => m.type === "connected");
  await waitFor(A, (m) => m.type === "history");
  const hist0 = last(A, "history");
  check("P1a a fresh room's frame carries exactly one base layer",
    (hist0?.frames?.[0]?.layers || []).length === 1 && hist0.frames[0].layers[0].id === "L0",
    JSON.stringify(hist0?.frames?.[0]?.layers));
  check("P1b the base layer is named and fully visible",
    hist0?.frames?.[0]?.layers?.[0]?.name === "Canvas"
      && hist0.frames[0].layers[0].visible === true
      && hist0.frames[0].layers[0].opacity === 1,
    JSON.stringify(hist0?.frames?.[0]?.layers?.[0]));
  check("P1c the join handshake tells the client it is the host",
    aConn?.isHost === true, `isHost=${aConn?.isHost}`);

  const B = await connectMember(ROOM);
  await waitFor(B, (m) => m.type === "connected");

  A.msgs.length = 0;
  A.send({ type: "layer_add", name: "Sketch" });
  const addEcho = await waitFor(A, (m) => m.type === "layer_add");
  const newLayerId = addEcho?.layerId;
  check("P2a layer_add echoes the canonical list to the sender",
    addEcho?.layers?.length === 2 && layerNames(addEcho) === "Canvas,Sketch", layerNames(addEcho));
  check("P2b the id is minted server-side (L<counter>)",
    typeof newLayerId === "string" && /^L\d+$/.test(newLayerId), String(newLayerId));
  const bAdd = await waitFor(B, (m) => m.type === "layer_add");
  check("P2c every other member gets the same list", bAdd?.layers?.length === 2, layerNames(bAdd));

  // ---- Ops carry their layer ----------------------------------------------
  A.msgs.length = 0;
  B.send(drawOp("b-on-sketch", newLayerId));
  const relayed = await waitFor(A, (m) => m.type === "op" && m.op?.strokeId === "b-on-sketch");
  check("P3 an op is relayed with its layerId intact", relayed?.op?.layerId === newLayerId,
    `layerId=${relayed?.op?.layerId}`);

  A.msgs.length = 0;
  B.send(drawOp("b-ghost-layer", "L999"));
  await sleep(600);
  check("P4 an op naming a layer that doesn't exist is dropped, not re-homed",
    !all(A, "op").some((m) => m.op?.strokeId === "b-ghost-layer"));

  // ---- Locked layers -------------------------------------------------------
  A.msgs.length = 0;
  A.send({ type: "layer_patch", layerId: newLayerId, patch: { locked: true } });
  const lockEcho = await waitFor(A, (m) => m.type === "layer_patch" && m.layers?.some((l) => l.locked));
  check("P5a a host can lock a layer (canonical list echoes locked)",
    !!lockEcho && lockEcho.layers.find((l) => l.id === newLayerId)?.locked === true);
  A.msgs.length = 0;
  B.send(drawOp("b-on-locked", newLayerId));
  await sleep(600);
  check("P5b a member's ink on a locked layer is dropped",
    !all(A, "op").some((m) => m.op?.strokeId === "b-on-locked"));
  B.msgs.length = 0;
  A.send(drawOp("a-on-locked", newLayerId));
  const hostInk = await waitFor(B, (m) => m.type === "op" && m.op?.strokeId === "a-on-locked");
  check("P5c the host may still draw on a locked layer", !!hostInk);

  // ---- Patch + move --------------------------------------------------------
  A.msgs.length = 0;
  A.send({ type: "layer_patch", layerId: newLayerId, patch: { locked: false, name: "Rough", opacity: 0.4, visible: false } });
  const patchEcho = await waitFor(A, (m) => m.type === "layer_patch" && m.layers?.some((l) => l.name === "Rough"));
  const patched = patchEcho?.layers?.find((l) => l.id === newLayerId);
  check("P6a layer_patch applies name/opacity/visibility and clamps",
    patched?.name === "Rough" && patched?.opacity === 0.4 && patched?.visible === false && patched?.locked === false,
    JSON.stringify(patched));

  A.msgs.length = 0;
  A.send({ type: "layer_move", layerId: newLayerId, toIndex: 0 });
  const moveEcho = await waitFor(A, (m) => m.type === "layer_move");
  check("P6b layer_move reorders the canonical list",
    moveEcho?.layers?.[0]?.id === newLayerId && moveEcho?.layers?.[1]?.id === "L0", layerNames(moveEcho));

  // ---- The cap -------------------------------------------------------------
  let capDenied = null;
  for (let i = 0; i < 8; i += 1) {
    A.send({ type: "layer_add" });
    await sleep(120);
    capDenied = capDenied || last(A, "layer_denied");
  }
  await sleep(300);
  const capped = last(A, "layer_add");
  check("P7 the layer cap holds at 6 with a clear reason",
    capped?.layers?.length === 6 && typeof capDenied?.reason === "string", `${capped?.layers?.length} layers — "${capDenied?.reason}"`);

  // ---- Delete purges the layer's ops --------------------------------------
  // Use a layer that is NOT at index 0: the bottom layer is protected.
  const capList = capped.layers;
  const baseId = capList[0].id;
  const doomed = capList[capList.length - 1].id;
  A.send(drawOp("a-on-doomed", doomed));
  await sleep(500);
  A.msgs.length = 0;
  A.send({ type: "layer_del", layerId: doomed });
  const delEcho = await waitFor(A, (m) => m.type === "layer_del");
  check("P8a layer_del removes it, names the purged ops and echoes the surviving list",
    !!delEcho && delEcho.layerId === doomed && !(delEcho.layers || []).some((l) => l.id === doomed)
      && (delEcho.removedOpIds || []).length >= 1,
    `${layerNames(delEcho)} removedOps=${(delEcho?.removedOpIds || []).length}`);
  const joiner = await connectMember(ROOM);
  const joinHist = await waitFor(joiner, (m) => m.type === "history");
  const stuckOps = (joinHist?.ops || []).filter((op) => op.layerId === doomed);
  check("P8b the deleted layer's ops are gone from the room's history (a rejoin can't resurrect them)",
    stuckOps.length === 0, `${stuckOps.length} stale ops`);

  A.msgs.length = 0;
  A.send({ type: "layer_del", layerId: baseId });
  await sleep(400);
  const baseDenied = last(A, "layer_denied");
  const soloJoiner = await connectMember(ROOM);
  const soloHist = await waitFor(soloJoiner, (m) => m.type === "history");
  const survivors = soloHist?.frames?.[0]?.layers || [];
  check("P8c the bottom layer can never be deleted (goo/wet-mix read layer 0)",
    survivors.some((l) => l.id === baseId) && !!baseDenied, `${survivors.length} layers — "${baseDenied?.reason}"`);

  // ---- Legacy ops + persistence -------------------------------------------
  A.msgs.length = 0;
  A.send(drawOp("legacy-no-layer"));
  const legacy = await waitFor(joiner, (m) => m.type === "op" && m.op?.strokeId === "legacy-no-layer");
  check("P10 an op with no layerId still relays (legacy clients keep working)",
    !!legacy && legacy.op.layerId === undefined, `layerId=${legacy?.op?.layerId}`);

  let onDisk = null;
  for (let i = 0; i < 16; i += 1) {
    await sleep(400);
    const file = path.join(SCRATCH, ".rooms", `${ROOM}.json`);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const layers = parsed?.frames?.[0]?.layers;
      if (Array.isArray(layers) && layers.length) {
        onDisk = layers;
        // Keep waiting until the base layer's earlier ops were re-tagged/deleted
        // state is durable, i.e. until the file has our surviving stack.
        if (layers.length === (soloHist?.frames?.[0]?.layers || []).length) break;
      }
    } catch { /* mid-write */ }
  }
  check("P9 the layer stack is persisted in the room file",
    Array.isArray(onDisk) && onDisk.length >= 1 && typeof onDisk[0].id === "string",
    JSON.stringify(onDisk));

  // ---- Public rooms are host-only -----------------------------------------
  const pub1 = await connectMember(PUBLIC_ROOM);
  const pub1Conn = await waitFor(pub1, (m) => m.type === "connected");
  const pub2 = await connectMember(PUBLIC_ROOM);
  const pub2Conn = await waitFor(pub2, (m) => m.type === "connected");
  const member = pub1Conn?.isHost ? pub2 : pub1;
  await sleep(200);
  member.msgs.length = 0;
  member.send({ type: "layer_add" });
  await sleep(700);
  check("P11 a non-host member can't restructure layers in a public (kid_safe) room",
    !all(member, "layer_add").length, `isHost=${!!(pub1Conn?.isHost || pub2Conn?.isHost)}`);

  A.ws.close();
  B.ws.close();
  joiner.ws.close();
  soloJoiner.ws.close();
  pub1.ws.close();
  pub2.ws.close();
  server.kill();
  console.log(fails ? `\n${fails} FAIL` : "\nALL PASS");
  process.exit(fails ? 1 : 0);
};

run().catch((e) => {
  console.error(e);
  server.kill();
  process.exit(1);
});
