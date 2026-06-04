/*
 * Shared To-Do — Home Screens plugin bundle (no build step required).
 *
 * This is a hand-written IIFE that assigns its exports to window.__HS_PLUGIN__,
 * exactly like an esbuild --format=iife --global-name=__HS_PLUGIN__ output would.
 * React and the plugin SDK are read from the globals the host injects before
 * executing this bundle. If you prefer to edit in TSX/JSX, see ../src/index.tsx
 * and rebuild with ../build.sh — that produces a drop-in replacement for this file.
 */
(function () {
  "use strict";

  var React = window.React;
  if (!React) {
    // Surfaces a clear message instead of a blank module if the host global differs.
    window.__HS_PLUGIN__ = {
      default: function () {
        return null;
      },
    };
    console.error("[todo-sync] window.React not found — cannot mount plugin");
    return;
  }

  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useCallback = React.useCallback;
  var h = React.createElement;

  function sdk() {
    return window.__HS_SDK__ || {};
  }

  function hexToRgba(hex, a) {
    hex = String(hex || "").replace("#", "");
    if (hex.length === 3) {
      hex = hex.split("").map(function (c) { return c + c; }).join("");
    }
    var alpha = a == null ? 1 : a;
    if (hex.length !== 6 || /[^0-9a-fA-F]/.test(hex)) return "rgba(28,25,23," + alpha + ")";
    var n = parseInt(hex, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + alpha + ")";
  }

  // ---- helpers ---------------------------------------------------------------

  var PRIORITY_RANK = { high: 0, med: 1, medium: 1, low: 2 };
  var PRIORITY_COLOR = { high: "#ef4444", med: "#f59e0b", medium: "#f59e0b", low: "#22c55e" };
  var PRIORITY_LABEL = { high: "High", med: "Medium", medium: "Medium", low: "Low" };

  function todayStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function isOverdue(t) {
    return !t.completed && t.due && t.due < todayStr();
  }

  function dueLabel(due) {
    if (!due) return "";
    var today = todayStr();
    if (due === today) return "Today";
    // tomorrow
    var d = new Date(due + "T00:00:00");
    var tm = new Date();
    tm.setDate(tm.getDate() + 1);
    var tmStr =
      tm.getFullYear() +
      "-" +
      String(tm.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(tm.getDate()).padStart(2, "0");
    if (due === tmStr) return "Tomorrow";
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getMonth()] + " " + d.getDate();
  }

  function prank(t) {
    var p = (t.priority || "med").toLowerCase();
    return PRIORITY_RANK[p] != null ? PRIORITY_RANK[p] : 1;
  }

  function comparator(sortBy) {
    return function (a, b) {
      // Completed always sink below incomplete (except in pure created/alpha where we still group)
      if (a.completed !== b.completed) return a.completed ? 1 : -1;

      if (a.completed && b.completed) {
        return (b.completedAt || "").localeCompare(a.completedAt || "");
      }

      if (sortBy === "alpha") {
        return (a.text || "").localeCompare(b.text || "");
      }
      if (sortBy === "created") {
        return (a.createdAt || "").localeCompare(b.createdAt || "");
      }
      if (sortBy === "priority") {
        if (prank(a) !== prank(b)) return prank(a) - prank(b);
        return (a.due || "9999").localeCompare(b.due || "9999");
      }
      if (sortBy === "due") {
        return (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99");
      }
      // smart: overdue first, then due asc (none last), then priority, then created
      var ao = isOverdue(a) ? 0 : 1;
      var bo = isOverdue(b) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      var ad = a.due || "9999-99-99";
      var bd = b.due || "9999-99-99";
      if (ad !== bd) return ad.localeCompare(bd);
      if (prank(a) !== prank(b)) return prank(a) - prank(b);
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    };
  }

  function buildUrl(base, path) {
    var b = (base || "").replace(/\/+$/, "");
    return b + path;
  }

  // ---- data layer (via the host plugin proxy) -------------------------------

  function injections() {
    // Only meaningful if a sync_token secret is configured; harmless otherwise
    // because the server ignores auth when no token is set.
    return { header: { Authorization: "Bearer {{sync_token}}" } };
  }

  function fetchTodos(base) {
    var pf = sdk().pluginFetch;
    return pf("todo-sync", {
      url: buildUrl(base, "/api/todos"),
      method: "GET",
      cacheTtlMs: 0,
      secretInjections: injections(),
    }).then(function (res) {
      return res.json();
    });
  }

  function patchTodo(base, id, patch) {
    var pf = sdk().pluginFetch;
    return pf("todo-sync", {
      url: buildUrl(base, "/api/todos/" + encodeURIComponent(id)),
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      payload: JSON.stringify(patch),
      cacheTtlMs: 0,
      secretInjections: injections(),
    });
  }

  // ---- component -------------------------------------------------------------

  function TodoSync(props) {
    var config = (props && props.config) || {};
    var accent = config.accentColor || "#EA580C";
    var serviceUrl = config.serviceUrl || "";
    var pollMs = Math.max(2, Number(config.pollSeconds) || 4) * 1000;

    var stateTodos = useState([]);
    var todos = stateTodos[0];
    var setTodos = stateTodos[1];

    var stateError = useState(null);
    var error = stateError[0];
    var setError = stateError[1];

    var stateLoaded = useState(false);
    var loaded = stateLoaded[0];
    var setLoaded = stateLoaded[1];

    // ids with an in-flight optimistic toggle, so the poll doesn't clobber them
    var pendingRef = useRef({});
    var mountedRef = useRef(true);

    var load = useCallback(
      function () {
        if (!serviceUrl) {
          setError("Set the sync service URL in this module's settings.");
          setLoaded(true);
          return;
        }
        fetchTodos(serviceUrl)
          .then(function (data) {
            if (!mountedRef.current) return;
            var incoming = (data && data.todos) || [];
            // preserve any locally pending toggles
            var pend = pendingRef.current;
            if (Object.keys(pend).length) {
              incoming = incoming.map(function (t) {
                if (pend[t.id] != null) {
                  return Object.assign({}, t, { completed: pend[t.id] });
                }
                return t;
              });
            }
            setTodos(incoming);
            setError(null);
            setLoaded(true);
          })
          .catch(function (e) {
            if (!mountedRef.current) return;
            setError("Can't reach the to-do service. Check the URL and that the server is running.");
            setLoaded(true);
            console.error("[todo-sync] fetch failed", e);
          });
      },
      [serviceUrl]
    );

    useEffect(
      function () {
        mountedRef.current = true;
        load();
        var id = setInterval(load, pollMs);
        return function () {
          mountedRef.current = false;
          clearInterval(id);
        };
      },
      [load, pollMs]
    );

    var toggle = useCallback(
      function (t) {
        var next = !t.completed;
        pendingRef.current[t.id] = next;
        // optimistic local update
        setTodos(function (cur) {
          return cur.map(function (x) {
            return x.id === t.id
              ? Object.assign({}, x, {
                  completed: next,
                  completedAt: next ? new Date().toISOString() : null,
                })
              : x;
          });
        });
        patchTodo(serviceUrl, t.id, { completed: next })
          .then(function () {
            delete pendingRef.current[t.id];
            load(); // pull authoritative state so all displays converge
          })
          .catch(function (e) {
            delete pendingRef.current[t.id];
            // revert on failure
            setTodos(function (cur) {
              return cur.map(function (x) {
                return x.id === t.id ? Object.assign({}, x, { completed: t.completed }) : x;
              });
            });
            console.error("[todo-sync] toggle failed", e);
          });
      },
      [serviceUrl, load]
    );

    // visible set
    var hideAfter = Number(config.hideCompletedMinutes) || 0;
    var nowMs = Date.now();
    var visible = todos.filter(function (t) {
      if (t.completed) {
        if (config.showCompleted === false) return false;
        if (hideAfter > 0 && t.completedAt) {
          var age = nowMs - new Date(t.completedAt).getTime();
          if (age > hideAfter * 60000) return false;
        }
      }
      return true;
    });
    visible.sort(comparator(config.sortBy || "smart"));
    var maxItems = Number(config.maxItems) || 12;
    var shown = visible.slice(0, maxItems);
    var hiddenCount = visible.length - shown.length;

    var remaining = todos.filter(function (t) {
      return !t.completed;
    }).length;

    var ModuleLoadingState = sdk().ModuleLoadingState;

    var body = h(
      "div",
      {
        style: {
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
          color: "inherit",
          overflow: "hidden",
          boxSizing: "border-box",
          padding: 16,
          borderRadius: config.cornerRadius != null ? config.cornerRadius : 16,
          backgroundColor: hexToRgba(config.bgColor || "#1c1917", config.bgOpacity != null ? config.bgOpacity : 0.55),
          backdropFilter: config.blur ? "blur(" + config.blur + "px)" : undefined,
          WebkitBackdropFilter: config.blur ? "blur(" + config.blur + "px)" : undefined,
        },
      },
      // header
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            marginBottom: 10,
            flex: "0 0 auto",
          },
        },
        h("span", { style: { fontSize: "1.4em", fontWeight: 700, letterSpacing: "-0.01em" } }, config.title || "To-Do"),
        h(
          "span",
          { style: { fontSize: "0.85em", opacity: 0.7 } },
          remaining + (remaining === 1 ? " left" : " left")
        )
      ),
      // list
      h(
        "div",
        { style: { flex: "1 1 auto", overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 } },
        shown.length === 0
          ? h("div", { style: { opacity: 0.55, fontSize: "0.95em", padding: "8px 2px" } }, "Nothing here \u2014 add a task from your phone.")
          : shown.map(function (t) {
              return renderRow(t, config, accent, toggle);
            }),
        hiddenCount > 0
          ? h("div", { style: { opacity: 0.5, fontSize: "0.8em", padding: "4px 2px" } }, "+ " + hiddenCount + " more")
          : null
      )
    );

    if (ModuleLoadingState) {
      return h(ModuleLoadingState, { loading: !loaded, error: error }, body);
    }
    // fallback if SDK component unavailable
    if (!loaded) return h("div", { style: { opacity: 0.6 } }, "Loading\u2026");
    if (error) return h("div", { style: { color: "#fca5a5", fontSize: "0.9em" } }, error);
    return body;
  }

  function renderRow(t, config, accent, toggle) {
    var done = !!t.completed;
    var overdue = isOverdue(t);
    var pColor = PRIORITY_COLOR[(t.priority || "med").toLowerCase()] || "#f59e0b";

    var checkbox = h(
      "div",
      {
        style: {
          flex: "0 0 auto",
          width: 26,
          height: 26,
          borderRadius: 999,
          border: "2px solid " + (done ? accent : "rgba(255,255,255,0.45)"),
          background: done ? accent : "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 120ms ease",
        },
      },
      done
        ? h(
            "svg",
            { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none" },
            h("path", { d: "M5 13l4 4L19 7", stroke: "#fff", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" })
          )
        : null
    );

    var metaBits = [];
    if (config.showDue !== false && t.due) {
      metaBits.push(
        h(
          "span",
          {
            key: "due",
            style: {
              fontSize: "0.72em",
              padding: "1px 7px",
              borderRadius: 6,
              background: overdue ? "rgba(239,68,68,0.18)" : "rgba(255,255,255,0.1)",
              color: overdue ? "#fca5a5" : "inherit",
              fontWeight: overdue ? 700 : 500,
            },
          },
          dueLabel(t.due)
        )
      );
    }
    if (config.showAssignee !== false && t.assignee) {
      metaBits.push(
        h(
          "span",
          {
            key: "who",
            style: {
              fontSize: "0.72em",
              padding: "1px 7px",
              borderRadius: 6,
              background: "rgba(255,255,255,0.1)",
              opacity: 0.85,
            },
          },
          t.assignee
        )
      );
    }

    var textBlock = h(
      "div",
      { style: { flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } },
      h(
        "span",
        {
          style: {
            fontSize: "1em",
            lineHeight: 1.25,
            textDecoration: done ? "line-through" : "none",
            opacity: done ? 0.5 : 1,
            wordBreak: "break-word",
          },
        },
        t.text || ""
      ),
      metaBits.length ? h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } }, metaBits) : null
    );

    return h(
      "button",
      {
        key: t.id,
        onClick: function () {
          toggle(t);
        },
        style: {
          display: "flex",
          alignItems: "center",
          gap: 12,
          textAlign: "left",
          width: "100%",
          minHeight: 52,
          padding: "8px 10px",
          borderRadius: 12,
          border: "none",
          borderLeft: "4px solid " + (done ? "transparent" : pColor),
          background: "rgba(255,255,255,0.06)",
          color: "inherit",
          font: "inherit",
          cursor: "pointer",
          WebkitTapHighlightColor: "transparent",
        },
      },
      checkbox,
      textBlock
    );
  }

  window.__HS_PLUGIN__ = { default: TodoSync };
})();
