import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const ROOT = resolve(".");
const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XnR+AAAAAElFTkSuQmCC";

function startServer(dataDir) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      PB_URL: "",
      ADMIN_KEY: "creative-five-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/healthz`, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  }
  throw new Error("test server did not become healthy");
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolveWait) => {
    child.once("exit", resolveWait);
    setTimeout(resolveWait, 2000);
  });
}

async function json(path, options) {
  const response = await fetch(`${BASE}${path}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function connectRoom(code) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${encodeURIComponent(code)}`);
  const messages = [];
  const waiters = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    messages.push(value);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(value)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
    }
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  const waitFor = (predicate, timeoutMs = 2500) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, resolve: resolveWait, timer: null };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        rejectWait(new Error(`message timeout for room ${code}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return { socket, messages, waitFor, send: (value) => socket.send(JSON.stringify(value)) };
}

test("Creative Five anonymous room, quest, storybook, and remix flows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "drawesome-creative-five-"));
  assert.equal(resolve(dataDir).startsWith(resolve(tmpdir())), true);
  let server = startServer(dataDir);
  const clients = [];
  try {
    await waitForHealth();

    const publicRooms = await json("/api/rooms/public");
    assert.equal(publicRooms.response.status, 200);
    const roomCodes = new Set(publicRooms.body.rooms.map((room) => room.code));
    assert.equal(roomCodes.has("KALEIDO"), true);
    assert.equal(roomCodes.has("QUEST"), true);
    assert.equal(roomCodes.has("ORCHSTRA"), true);
    assert.equal(roomCodes.has("STORYBOOK"), false, "storybook is a project launcher, not a global room");

    const kaleido = await connectRoom("KALEIDO");
    clients.push(kaleido);
    const kaleidoConnected = await kaleido.waitFor((message) => message.type === "connected");
    assert.deepEqual(kaleidoConnected.symmetry, { mode: "quad", copies: 4 });
    // Public Kaleido is a fixed shared rule; visitors cannot drift the room
    // into a different mode for everyone else.
    kaleido.send({ type: "set_symmetry", mode: "radial" });
    const kaleidoPeer = await connectRoom("KALEIDO");
    clients.push(kaleidoPeer);
    const kaleidoPeerConnected = await kaleidoPeer.waitFor((message) => message.type === "connected");
    assert.deepEqual(kaleidoPeerConnected.symmetry, { mode: "quad", copies: 4 });

    const questA = await connectRoom("QUEST");
    const questB = await connectRoom("QUEST");
    clients.push(questA, questB);
    const questConnected = await questB.waitFor((message) => message.type === "connected");
    const missionId = questConnected.quests.missions[0].id;
    questA.send({ type: "quest_nominate", missionId });
    const oneVote = await questA.waitFor(
      (message) => message.type === "quest_state" && message.quest.counts[missionId] === 1,
    );
    assert.equal(oneVote.quest.needed, 2);
    assert.equal(oneVote.quest.completedIds.includes(missionId), false);
    questB.send({ type: "quest_nominate", missionId });
    const completed = await questA.waitFor(
      (message) => message.type === "quest_state" && message.justCompleted === missionId,
    );
    assert.equal(completed.quest.completedIds.includes(missionId), true);

    const createdBook = await json("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audience: "friends", mode: "storybook", title: "Test Story" }),
    });
    assert.equal(createdBook.response.status, 200);
    const bookCode = createdBook.body.code;
    const author = await connectRoom(bookCode);
    const collaborator = await connectRoom(bookCode);
    clients.push(author, collaborator);
    const authorConnected = await author.waitFor((message) => message.type === "connected");
    const collaboratorConnected = await collaborator.waitFor((message) => message.type === "connected");
    assert.equal(authorConnected.isHost, true);
    assert.equal(collaboratorConnected.isHost, false);
    assert.equal(authorConnected.storybook.pages.length, 4);
    assert.equal(authorConnected.animation, true);
    const firstPage = authorConnected.storybook.pages[0];
    author.send({ type: "storybook_caption", sceneId: firstPage.sceneId, caption: "A small hero wakes up." });
    const captioned = await collaborator.waitFor(
      (message) => message.type === "storybook_state" && message.storybook.pages[0].caption,
    );
    assert.equal(captioned.storybook.pages[0].caption, "A small hero wakes up.");
    author.send({ type: "storybook_lock", sceneId: firstPage.sceneId, locked: true });
    const locked = await collaborator.waitFor(
      (message) => message.type === "storybook_state" && message.storybook.pages[0].locked === true,
    );
    assert.equal(locked.storybook.pages[0].locked, true);

    const sourcePost = await json("/api/wall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userKey: "u_creative_test",
        title: "Remix Seed",
        artist: "Test Artist",
        frames: [PNG_1X1],
        tags: ["remix"],
        allowRemix: true,
      }),
    });
    assert.equal(sourcePost.response.status, 200);
    const sourceId = sourcePost.body.id;
    const remixRoom = await json(`/api/wall/${sourceId}/remix-room`, { method: "POST" });
    assert.equal(remixRoom.response.status, 200);
    const remixer = await connectRoom(remixRoom.body.code);
    clients.push(remixer);
    const remixConnected = await remixer.waitFor((message) => message.type === "connected");
    assert.equal(remixConnected.remixSource.id, sourceId);
    const remixSheet = await remixer.waitFor((message) => message.type === "sheet");
    assert.equal(remixSheet.sheetId, `remix:${sourceId}`);

    const descendant = await json("/api/wall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userKey: "u_creative_descendant",
        title: "Remix Child",
        artist: "Another Artist",
        frames: [PNG_1X1],
        tags: ["remix"],
        parentPostId: sourceId,
      }),
    });
    assert.equal(descendant.response.status, 200);
    const wall = await json("/api/wall?sort=new&limit=20");
    const child = wall.body.posts.find((post) => post.id === descendant.body.id);
    assert.equal(child.parentPostId, sourceId);
    assert.equal(child.rootPostId, sourceId);

    // Room persistence is intentionally write-behind so drawing traffic never
    // blocks on disk. Let the debounce flush before simulating a restart.
    await new Promise((resolve) => setTimeout(resolve, 2800));
    for (const client of clients.splice(0)) client.socket.close();
    await stopServer(server);
    server = startServer(dataDir);
    await waitForHealth();
    const restored = await connectRoom(bookCode);
    clients.push(restored);
    const restoredConnected = await restored.waitFor((message) => message.type === "connected");
    assert.equal(restoredConnected.storybook.pages[0].caption, "A small hero wakes up.");
    assert.equal(restoredConnected.storybook.pages[0].locked, true);
  } finally {
    for (const client of clients) client.socket.close();
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
