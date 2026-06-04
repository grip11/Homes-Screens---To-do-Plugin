#!/usr/bin/env node
/*
 * Shared To-Do sync service.
 *
 * One file, zero dependencies. Owns the household task list and serves the
 * phone web app. Run it on your Pi:
 *
 *     node todo-server.mjs
 *
 * Environment variables (all optional):
 *     PORT        Port to listen on            (default 8787)
 *     DATA_FILE   Where the JSON list is saved (default ./todos.json)
 *     SYNC_TOKEN  Shared secret. If set, every /api request must send
 *                 "Authorization: Bearer <token>". Leave unset for an open
 *                 service on your home LAN. If you set it here, set the same
 *                 value as the plugin's sync_token secret and in the phone app.
 *
 * Completed-task lifecycle:
 *     A checked-off task lingers for the rest of the local day so you can see
 *     what got done (and restore it if you tapped it by mistake). At local
 *     midnight it is purged. "Local" means this machine's clock/timezone, so
 *     make sure the Pi's timezone is right (check with `timedatectl`).
 */

import http from "node:http";
import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.DATA_FILE || join(__dirname, "todos.json");
const TOKEN = process.env.SYNC_TOKEN || "";
const PUBLIC_DIR = join(__dirname, "public");

const PRIORITIES = new Set(["high", "med", "low"]);

// ---- persistence -----------------------------------------------------------

let state = { rev: 0, todos: [] };
let saving = Promise.resolve();

async function loadState() {
  if (existsSync(DATA_FILE)) {
    try {
      const raw = await readFile(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.todos)) {
        state = { rev: Number(parsed.rev) || 0, todos: parsed.todos };
      }
    } catch (e) {
      console.error("Could not read", DATA_FILE, "- starting empty.", e.message);
    }
  }
}

function persist() {
  // serialize writes; write to a temp file then atomically rename
  saving = saving.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, DATA_FILE);
  });
  return saving;
}

// ---- helpers ----------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

// Local calendar day (YYYY-MM-DD) for a Date or ISO string, in this machine's
// timezone. Used to decide whether a completed task is still "today's".
function localDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return (
    dt.getFullYear() +
    "-" +
    String(dt.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(dt.getDate()).padStart(2, "0")
  );
}

// Drop completed tasks that were finished on an earlier local day. Returns
// true if anything was removed (so the caller knows to persist). Active tasks
// and tasks completed today are always kept. A completed task missing its
// completedAt is treated as "today" so it is never silently lost.
function sweepCompleted() {
  const today = localDay(new Date());
  const before = state.todos.length;
  state.todos = state.todos.filter(
    (t) => !t.completed || !t.completedAt || localDay(t.completedAt) === today
  );
  if (state.todos.length !== before) {
    state.rev++;
    return true;
  }
  return false;
}

function normalizePriority(p) {
  if (typeof p !== "string") return "med";
  const v = p.toLowerCase();
  if (v === "medium") return "med";
  return PRIORITIES.has(v) ? v : "med";
}

function normalizeDue(d) {
  if (d == null || d === "") return null;
  // accept YYYY-MM-DD only
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : null;
}

function makeTodo(input) {
  const t = nowIso();
  return {
    id: randomUUID(),
    text: String(input.text || "").trim(),
    completed: !!input.completed,
    completedAt: input.completed ? t : null,
    priority: normalizePriority(input.priority),
    due: normalizeDue(input.due),
    assignee: String(input.assignee || "").trim(),
    createdAt: t,
    updatedAt: t,
  };
}

function applyPatch(todo, patch) {
  if (typeof patch.text === "string") todo.text = patch.text.trim();
  if (typeof patch.assignee === "string") todo.assignee = patch.assignee.trim();
  if ("priority" in patch) todo.priority = normalizePriority(patch.priority);
  if ("due" in patch) todo.due = normalizeDue(patch.due);
  if (typeof patch.completed === "boolean") {
    if (patch.completed && !todo.completed) todo.completedAt = nowIso();
    if (!patch.completed) todo.completedAt = null;
    todo.completed = patch.completed;
  }
  todo.updatedAt = nowIso();
  return todo;
}

// ---- http -------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(res, fileRel) {
  const file = fileRel === "/" ? "/index.html" : fileRel;
  const full = join(PUBLIC_DIR, file.replace(/\.\./g, ""));
  if (!full.startsWith(PUBLIC_DIR) || !existsSync(full)) {
    return send(res, 404, "Not found");
  }
  const ext = full.slice(full.lastIndexOf("."));
  const body = await readFile(full);
  res.writeHead(200, { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, "");

  // ---- API ----
  if (path.startsWith("/api/")) {
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    try {
      // GET /api/todos
      if (path === "/api/todos" && req.method === "GET") {
        // Purge yesterday's completed tasks before serving so every device
        // converges on the same "today only" completed list.
        if (sweepCompleted()) await persist();
        return send(res, 200, state);
      }
      // POST /api/todos
      if (path === "/api/todos" && req.method === "POST") {
        const body = await readBody(req);
        if (!String(body.text || "").trim()) return send(res, 400, { error: "text required" });
        const todo = makeTodo(body);
        state.todos.push(todo);
        state.rev++;
        await persist();
        return send(res, 201, todo);
      }
      // PATCH/DELETE /api/todos/:id
      const m = path.match(/^\/api\/todos\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const idx = state.todos.findIndex((t) => t.id === id);
        if (idx === -1) return send(res, 404, { error: "not found" });

        if (req.method === "PATCH") {
          const body = await readBody(req);
          applyPatch(state.todos[idx], body);
          state.rev++;
          await persist();
          return send(res, 200, state.todos[idx]);
        }
        if (req.method === "DELETE") {
          const [removed] = state.todos.splice(idx, 1);
          state.rev++;
          await persist();
          return send(res, 200, { deleted: removed.id });
        }
      }
      return send(res, 404, { error: "no such route" });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  // ---- static (phone app) ----
  if (req.method === "GET") {
    return serveStatic(res, path);
  }
  return send(res, 405, "Method not allowed");
});

await loadState();
// Sweep once at boot (covers a restart that happens after midnight) ...
if (sweepCompleted()) await persist();
// ... and periodically, so an idle list still clears shortly after midnight
// even if no device polls it. Five minutes is plenty for a wall display.
setInterval(async () => {
  try {
    if (sweepCompleted()) await persist();
  } catch (e) {
    console.error("[todo] periodic sweep failed:", e.message);
  }
}, 5 * 60 * 1000).unref?.();

server.listen(PORT, () => {
  console.log(`Shared To-Do service listening on http://0.0.0.0:${PORT}`);
  console.log(`  Phone app:   open http://<this-pi-ip>:${PORT}/ on each phone`);
  console.log(`  Plugin URL:  set the module's "Sync service URL" to http://<this-pi-ip>:${PORT}`);
  console.log(`  Auth:        ${TOKEN ? "token required" : "open (no token)"}`);
  console.log(`  Data file:   ${DATA_FILE}`);
  console.log(`  Completed:   linger until local midnight (${localDay(new Date())} today)`);
});
