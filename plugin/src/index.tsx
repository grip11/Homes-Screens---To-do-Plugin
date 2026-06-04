// Shared To-Do — TSX source. Optional: edit here and rebuild with ../build.sh.
// The committed dist/bundle.js is hand-written and works without building; this
// file exists so you can iterate in JSX if you prefer.

declare global {
  interface Window {
    React: any;
    __HS_SDK__: any;
    __HS_PLUGIN__: any;
  }
}

const React = window.React;
const { useState, useEffect, useRef, useCallback } = React;
const sdk = () => window.__HS_SDK__ || {};

function hexToRgba(hex: string, a: number): string {
  let h = String(hex || "").replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const alpha = a == null ? 1 : a;
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return `rgba(28,25,23,${alpha})`;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

type Priority = "high" | "med" | "low";
interface Todo {
  id: string;
  text: string;
  completed: boolean;
  completedAt: string | null;
  priority: Priority;
  due: string | null; // YYYY-MM-DD
  assignee: string;
  createdAt: string;
  updatedAt: string;
}
interface Config {
  serviceUrl: string;
  title: string;
  sortBy: "smart" | "due" | "priority" | "created" | "alpha";
  showCompleted: boolean;
  hideCompletedMinutes: number;
  maxItems: number;
  showAssignee: boolean;
  showDue: boolean;
  accentColor: string;
  pollSeconds: number;
  bgColor: string;
  bgOpacity: number;
  cornerRadius: number;
  blur: number;
}

const PRIORITY_RANK: Record<string, number> = { high: 0, med: 1, medium: 1, low: 2 };
const PRIORITY_COLOR: Record<string, string> = { high: "#ef4444", med: "#f59e0b", medium: "#f59e0b", low: "#22c55e" };

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isOverdue = (t: Todo) => !t.completed && !!t.due && t.due < todayStr();
const prank = (t: Todo) => PRIORITY_RANK[(t.priority || "med").toLowerCase()] ?? 1;

function dueLabel(due: string | null): string {
  if (!due) return "";
  const today = todayStr();
  if (due === today) return "Today";
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);
  const tmStr = `${tm.getFullYear()}-${String(tm.getMonth() + 1).padStart(2, "0")}-${String(tm.getDate()).padStart(2, "0")}`;
  if (due === tmStr) return "Tomorrow";
  const d = new Date(due + "T00:00:00");
  const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${m[d.getMonth()]} ${d.getDate()}`;
}

function comparator(sortBy: Config["sortBy"]) {
  return (a: Todo, b: Todo) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.completed && b.completed) return (b.completedAt || "").localeCompare(a.completedAt || "");
    if (sortBy === "alpha") return (a.text || "").localeCompare(b.text || "");
    if (sortBy === "created") return (a.createdAt || "").localeCompare(b.createdAt || "");
    if (sortBy === "priority") return prank(a) - prank(b) || (a.due || "9999").localeCompare(b.due || "9999");
    if (sortBy === "due") return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99");
    const ao = isOverdue(a) ? 0 : 1;
    const bo = isOverdue(b) ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ad = a.due || "9999-99-99";
    const bd = b.due || "9999-99-99";
    if (ad !== bd) return ad.localeCompare(bd);
    return prank(a) - prank(b) || (a.createdAt || "").localeCompare(b.createdAt || "");
  };
}

const buildUrl = (base: string, path: string) => (base || "").replace(/\/+$/, "") + path;
const injections = () => ({ header: { Authorization: "Bearer {{sync_token}}" } });

const fetchTodos = (base: string) =>
  sdk()
    .pluginFetch("todo-sync", { url: buildUrl(base, "/api/todos"), method: "GET", cacheTtlMs: 0, secretInjections: injections() })
    .then((r: Response) => r.json());

const patchTodo = (base: string, id: string, patch: Partial<Todo>) =>
  sdk().pluginFetch("todo-sync", {
    url: buildUrl(base, `/api/todos/${encodeURIComponent(id)}`),
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    payload: JSON.stringify(patch),
    cacheTtlMs: 0,
    secretInjections: injections(),
  });

export default function TodoSync({ config }: { config: Config }) {
  const accent = config.accentColor || "#EA580C";
  const serviceUrl = config.serviceUrl || "";
  const pollMs = Math.max(2, Number(config.pollSeconds) || 4) * 1000;

  const [todos, setTodos] = useState<Todo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pendingRef = useRef<Record<string, boolean>>({});
  const mountedRef = useRef(true);

  const load = useCallback(() => {
    if (!serviceUrl) {
      setError("Set the sync service URL in this module's settings.");
      setLoaded(true);
      return;
    }
    fetchTodos(serviceUrl)
      .then((data: { todos: Todo[] }) => {
        if (!mountedRef.current) return;
        let incoming = data?.todos || [];
        const pend = pendingRef.current;
        if (Object.keys(pend).length) {
          incoming = incoming.map((t) => (pend[t.id] != null ? { ...t, completed: pend[t.id] } : t));
        }
        setTodos(incoming);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!mountedRef.current) return;
        setError("Can't reach the to-do service. Check the URL and that the server is running.");
        setLoaded(true);
        console.error("[todo-sync] fetch failed", e);
      });
  }, [serviceUrl]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const id = setInterval(load, pollMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, pollMs]);

  const toggle = useCallback(
    (t: Todo) => {
      const next = !t.completed;
      pendingRef.current[t.id] = next;
      setTodos((cur) =>
        cur.map((x) => (x.id === t.id ? { ...x, completed: next, completedAt: next ? new Date().toISOString() : null } : x))
      );
      patchTodo(serviceUrl, t.id, { completed: next })
        .then(() => {
          delete pendingRef.current[t.id];
          load();
        })
        .catch((e: unknown) => {
          delete pendingRef.current[t.id];
          setTodos((cur) => cur.map((x) => (x.id === t.id ? { ...x, completed: t.completed } : x)));
          console.error("[todo-sync] toggle failed", e);
        });
    },
    [serviceUrl, load]
  );

  const hideAfter = Number(config.hideCompletedMinutes) || 0;
  const nowMs = Date.now();
  const visible = todos
    .filter((t) => {
      if (t.completed) {
        if (config.showCompleted === false) return false;
        if (hideAfter > 0 && t.completedAt && nowMs - new Date(t.completedAt).getTime() > hideAfter * 60000) return false;
      }
      return true;
    })
    .sort(comparator(config.sortBy || "smart"));
  const maxItems = Number(config.maxItems) || 12;
  const shown = visible.slice(0, maxItems);
  const remaining = todos.filter((t) => !t.completed).length;
  const { ModuleLoadingState } = sdk();

  const body = (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%", color: "inherit", overflow: "hidden", boxSizing: "border-box", padding: 16, borderRadius: config.cornerRadius != null ? config.cornerRadius : 16, backgroundColor: hexToRgba(config.bgColor || "#1c1917", config.bgOpacity != null ? config.bgOpacity : 0.55), backdropFilter: config.blur ? `blur(${config.blur}px)` : undefined, WebkitBackdropFilter: config.blur ? `blur(${config.blur}px)` : undefined }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: "1.4em", fontWeight: 700 }}>{config.title || "To-Do"}</span>
        <span style={{ fontSize: "0.85em", opacity: 0.7 }}>{remaining} left</span>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.length === 0 ? (
          <div style={{ opacity: 0.55, fontSize: "0.95em", padding: "8px 2px" }}>Nothing here — add a task from your phone.</div>
        ) : (
          shown.map((t) => <Row key={t.id} t={t} config={config} accent={accent} onToggle={toggle} />)
        )}
      </div>
    </div>
  );

  if (ModuleLoadingState) return <ModuleLoadingState loading={!loaded} error={error}>{body}</ModuleLoadingState>;
  if (!loaded) return <div style={{ opacity: 0.6 }}>Loading…</div>;
  if (error) return <div style={{ color: "#fca5a5" }}>{error}</div>;
  return body;
}

function Row({ t, config, accent, onToggle }: { t: Todo; config: Config; accent: string; onToggle: (t: Todo) => void }) {
  const done = !!t.completed;
  const overdue = isOverdue(t);
  const pColor = PRIORITY_COLOR[(t.priority || "med").toLowerCase()] || "#f59e0b";
  return (
    <button
      onClick={() => onToggle(t)}
      style={{
        display: "flex", alignItems: "center", gap: 12, textAlign: "left", width: "100%", minHeight: 52,
        padding: "8px 10px", borderRadius: 12, border: "none",
        borderLeft: `4px solid ${done ? "transparent" : pColor}`,
        background: "rgba(255,255,255,0.06)", color: "inherit", font: "inherit", cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <div style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: 999, border: `2px solid ${done ? accent : "rgba(255,255,255,0.45)"}`, background: done ? accent : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
        {done && (
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none">
            <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ textDecoration: done ? "line-through" : "none", opacity: done ? 0.5 : 1, wordBreak: "break-word", lineHeight: 1.25 }}>{t.text}</span>
        {(config.showDue !== false && t.due) || (config.showAssignee !== false && t.assignee) ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {config.showDue !== false && t.due && (
              <span style={{ fontSize: "0.72em", padding: "1px 7px", borderRadius: 6, background: overdue ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.1)", color: overdue ? "#fca5a5" : "inherit", fontWeight: overdue ? 700 : 500 }}>{dueLabel(t.due)}</span>
            )}
            {config.showAssignee !== false && t.assignee && (
              <span style={{ fontSize: "0.72em", padding: "1px 7px", borderRadius: 6, background: "rgba(255,255,255,0.1)", opacity: 0.85 }}>{t.assignee}</span>
            )}
          </div>
        ) : null}
      </div>
    </button>
  );
}
