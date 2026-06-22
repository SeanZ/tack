/* tack dashboard — vanilla JS, polls /api/data every 5s */

/* ── theme: follow system by default, manual override persists ── */
(function initTheme() {
  const KEY = "tack-theme";
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const systemTheme = () => (mq.matches ? "light" : "dark");
  const apply = (t) => document.documentElement.setAttribute("data-theme", t);

  // saved explicit choice wins; otherwise follow system
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch {}
  apply(saved || systemTheme());

  // when following system (no saved choice), react to OS theme changes
  mq.addEventListener("change", () => {
    let s = null;
    try { s = localStorage.getItem(KEY); } catch {}
    if (!s) apply(systemTheme());
  });

  window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme");
      const next = cur === "light" ? "dark" : "light";
      apply(next);
      try { localStorage.setItem(KEY, next); } catch {}
    });
  });
})();

const BOXES = [
  { key: "inbox", name: "INBOX", color: "var(--inbox)" },
  { key: "processing", name: "PROCESSING", color: "var(--processing)" },
  { key: "backlog", name: "BACKLOG", color: "var(--backlog)" },
  { key: "archived", name: "ARCHIVED", color: "var(--archived)" },
];

let LAST = null; // last payload, for drawer lookups
let lastFetchTs = 0;
let lastSig = null; // signature of last rendered data (skip re-render if unchanged)
let openTaskId = null; // currently open drawer task, to re-sync on data change
let chartRange = "day"; // throughput chart granularity: "day" | "week"
let selectedLane = null; // 主线 whose detail card is open (null = none)

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const esc = (s) => String(s == null ? "" : s);

function shortUuid(u) {
  return u && u.length > 8 ? u.slice(0, 8) : u;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

// cheap signature: everything except the always-changing generated_at
function signatureOf(data) {
  return JSON.stringify({ stats: data.stats, tasks: data.tasks, meta: data.meta });
}

async function load() {
  try {
    const r = await fetch("/api/data", { cache: "no-store" });
    const data = await r.json();
    LAST = data;
    lastFetchTs = Date.now();
    const sig = signatureOf(data);
    if (sig === lastSig) return; // no change → no flash, just keep the page
    lastSig = sig;
    render(data);
    // if a drawer was open, re-sync its content with fresh data
    if (openTaskId && data.tasks.some((t) => t.id === openTaskId)) {
      fillDrawer(openTaskId);
    }
  } catch (e) {
    $("brandSub").textContent = "连接断开 — tack web 是否还在运行?";
  }
}

function render(data) {
  const { stats, tasks } = data;

  $("brandSub").textContent =
    `${stats.total} tasks · ${stats.sessions} sessions · ${stats.laneCount} lanes`;
  if (stats.sessionSpan) {
    $("spanRange").textContent =
      `${stats.sessionSpan.from.slice(5, 10)} → ${stats.sessionSpan.to.slice(5, 10)}`;
  }

  renderTiles(stats);
  renderBoard(tasks, stats);
  renderThroughput();
  renderBars("laneBars", stats.lane, { strip: "lane:", color: "var(--accent)" });
  renderBars("repoBars", stats.repo, { color: "var(--inbox)" });
  renderBars(
    "targetBars",
    stats.target,
    { color: "var(--target)", colorMap: { none: "var(--backlog)" } }
  );
}

function renderTiles(stats) {
  const host = $("tiles");
  host.innerHTML = "";
  const defs = [
    { key: "inbox", label: "Inbox", color: "var(--inbox)", foot: "待决定" },
    { key: "processing", label: "Processing", color: "var(--processing)", foot: "进行中", accent: true },
    { key: "backlog", label: "Backlog", color: "var(--backlog)", foot: "暂存" },
    { key: "archived", label: "Archived", color: "var(--archived)", foot: "已归档" },
  ];
  for (const d of defs) {
    const t = el("div", "tile" + (d.accent ? " is-accent" : ""));
    t.style.setProperty("--tcol", d.color);
    t.appendChild(el("div", "t-label", d.label));
    t.appendChild(el("div", "t-num", String(stats.box[d.key] ?? 0)));
    t.appendChild(el("div", "t-foot", d.foot));
    host.appendChild(t);
  }
}

function renderBoard(tasks, stats) {
  const host = $("board");
  host.innerHTML = "";
  for (const box of BOXES) {
    const col = el("div", "col");
    col.style.setProperty("--ccol", box.color);

    const head = el("div", "col-head");
    const name = el("div", "c-name", box.name);
    head.appendChild(name);
    head.appendChild(el("div", "c-count", String(stats.box[box.key] ?? 0)));
    col.appendChild(head);

    const items = tasks
      .filter((t) => t.state === box.key)
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

    if (items.length === 0) {
      col.appendChild(el("div", "cards empty", "—"));
    } else {
      const cards = el("div", "cards");
      for (const t of items) cards.appendChild(taskCard(t));
      col.appendChild(cards);
    }
    host.appendChild(col);
  }
}

function taskCard(t) {
  const c = el("div", "card");
  c.onclick = () => openDrawer(t.id);

  const top = el("div", "c-top");
  top.appendChild(el("span", "c-id", t.id));
  if (t.sessions.length) top.appendChild(el("span", "c-sess", `${t.sessions.length}s`));
  c.appendChild(top);

  c.appendChild(el("div", "c-title", t.title));

  const meta = el("div", "c-meta");
  if (t.repo) meta.appendChild(el("span", "chip repo", t.repo));
  const lanes = t.tags.filter((g) => g.startsWith("lane:"));
  for (const l of lanes.slice(0, 2)) meta.appendChild(el("span", "chip lane", l.replace("lane:", "")));
  const et = t.effective_target;
  if (et && et.value) {
    meta.appendChild(el("span", "chip target", et.derived ? et.value + "~" : et.value));
  }
  c.appendChild(meta);
  return c;
}

function renderBars(hostId, obj, opts = {}) {
  const host = $(hostId);
  host.innerHTML = "";
  const entries = Object.entries(obj)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  for (const [k, v] of entries) {
    const label = opts.strip ? k.replace(opts.strip, "") : k;
    const row = el("div", "bar-row");
    row.appendChild(el("div", "bar-label", label));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${(v / max) * 100}%`;
    const color = (opts.colorMap && opts.colorMap[k]) || opts.color || "var(--accent)";
    fill.style.background = color;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("div", "bar-val", String(v)));
    host.appendChild(row);
  }
  if (entries.length === 0) host.appendChild(el("div", "empty-note", "—"));
}

/* ── throughput / burndown chart ─────────────────────────── */
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

// "2026-06-08" → "06-08"
function bucketLabel(key) {
  return key.slice(5);
}

// per-lane task counts (from the live task list)
function laneStatsFor(lane) {
  const out = { total: 0, inbox: 0, processing: 0, backlog: 0, archived: 0 };
  for (const t of LAST?.tasks || []) {
    if (t.tags?.includes(lane)) { out.total++; out[t.state] = (out[t.state] ?? 0) + 1; }
  }
  return out;
}

// 主线 strip below the chart: one pill per lane showing its task count.
// Clicking a pill toggles an inline detail card — it never rebuilds the chart
// or the strip itself, so focus is kept and the page does not jump.
function renderLaneBar() {
  const host = $("chartLanes");
  if (!host) return;
  const lanes = LAST?.stats?.throughput?.lanes || [];
  if (selectedLane && !lanes.includes(selectedLane)) selectedLane = null;
  host.innerHTML = "";
  if (!lanes.length) { renderLaneDetail(); return; }

  host.appendChild(el("span", "lanes-label", `主线 ${lanes.length}`));
  for (const l of lanes) {
    const st = laneStatsFor(l);
    const pill = el("button", "lane-pill" + (selectedLane === l ? " is-on" : ""));
    pill.type = "button";
    pill.appendChild(el("span", "lp-name", l.replace("lane:", "")));
    pill.appendChild(el("span", "lp-num", String(st.total)));
    pill.onclick = () => {
      selectedLane = selectedLane === l ? null : l;
      for (const p of host.querySelectorAll(".lane-pill")) p.classList.remove("is-on");
      if (selectedLane === l) pill.classList.add("is-on");
      renderLaneDetail();
    };
    host.appendChild(pill);
  }
  renderLaneDetail();
}

// inline detail card for the selected 主线
function renderLaneDetail() {
  const host = $("laneDetail");
  if (!host) return;
  if (!selectedLane) { host.hidden = true; host.innerHTML = ""; return; }

  const lane = selectedLane;
  const st = laneStatsFor(lane);
  const series = LAST?.stats?.throughput?.byLane?.[lane]?.[chartRange] || [];
  const c = series.reduce((s, d) => s + d.created, 0);
  const a = series.reduce((s, d) => s + d.archived, 0);
  const open = series.length ? series[series.length - 1].open : st.total - st.archived;

  host.hidden = false;
  host.innerHTML = "";

  const head = el("div", "ld-head");
  head.appendChild(el("span", "ld-name", lane.replace("lane:", "")));
  const close = el("button", "ld-close", "✕");
  close.type = "button";
  close.onclick = () => {
    selectedLane = null;
    for (const p of $("chartLanes").querySelectorAll(".lane-pill")) p.classList.remove("is-on");
    renderLaneDetail();
  };
  head.appendChild(close);
  host.appendChild(head);

  const stats = el("div", "ld-stats");
  const stat = (label, val, cls) => {
    const s = el("div", "ld-stat" + (cls ? " " + cls : ""));
    s.appendChild(el("div", "ld-v", String(val)));
    s.appendChild(el("div", "ld-l", label));
    return s;
  };
  stats.appendChild(stat("任务", st.total));
  stats.appendChild(stat("进行中", st.processing, "is-proc"));
  stats.appendChild(stat("未完成", st.total - st.archived, "is-open"));
  stats.appendChild(stat("已归档", st.archived, "is-arch"));
  host.appendChild(stats);

  const rangeLabel = chartRange === "day" ? "近 30 天" : "近 12 周";
  const sub = el("div", "ld-sub");
  sub.innerHTML =
    `${rangeLabel} · <span class="su-c">创建 ${c}</span> · ` +
    `<span class="su-a">归档 ${a}</span> · <span class="su-n">未完成 ${open}</span>`;
  host.appendChild(sub);

  if (series.some((d) => d.created || d.archived)) host.appendChild(laneSparkline(host, series));
}

// compact created/archived sparkline for the lane detail card
function laneSparkline(host, series) {
  const W = Math.max(240, Math.round(host.clientWidth) || 600);
  const H = 54;
  const n = series.length;
  const gw = W / n;
  const max = Math.max(1, ...series.map((d) => Math.max(d.created, d.archived)));
  const bw = Math.max(1.5, Math.min(8, gw * 0.34));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: String(H), class: "ld-spark" });
  series.forEach((d, i) => {
    const cx = gw * i + gw / 2;
    if (d.created > 0) {
      const h = (d.created / max) * (H - 2);
      svg.appendChild(svgEl("rect", { x: cx - bw - 0.5, y: H - h, width: bw, height: h, rx: 1.5, class: "tp-bar-c" }));
    }
    if (d.archived > 0) {
      const h = (d.archived / max) * (H - 2);
      svg.appendChild(svgEl("rect", { x: cx + 0.5, y: H - h, width: bw, height: h, rx: 1.5, class: "tp-bar-a" }));
    }
  });
  return svg;
}

function renderThroughput() {
  const host = $("throughputChart");
  if (!host) return;
  const tp = LAST?.stats?.throughput;
  const series = tp?.[chartRange] || [];

  const totC = series.reduce((s, d) => s + d.created, 0);
  const totA = series.reduce((s, d) => s + d.archived, 0);
  const net = totC - totA;
  const lanesN = tp?.lanes?.length || 0;
  const sumEl = $("chartSummary");
  if (sumEl) {
    const sign = net > 0 ? "+" : "";
    sumEl.innerHTML =
      `<span class="su su-c">创建 <b>${totC}</b></span>` +
      `<span class="su su-a">归档 <b>${totA}</b></span>` +
      `<span class="su su-n">净 <b>${sign}${net}</b></span>` +
      (lanesN ? `<span class="su su-m">主线 <b>${lanesN}</b></span>` : "");
  }

  if (!series.length) { host.replaceChildren(el("div", "empty-note", "—")); renderLaneBar(); return; }

  // coordinate system matches the container's pixel width (no distortion)
  const W = Math.max(320, Math.round(host.clientWidth) || 900);
  const H = 240;
  const padL = 30, padR = 34, padT = 14, padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = series.length;
  const groupW = plotW / n;

  const maxBar = Math.max(1, ...series.map((d) => Math.max(d.created, d.archived)));
  const maxOpen = Math.max(1, ...series.map((d) => d.open));

  const yBar = (v) => padT + plotH - (v / maxBar) * plotH;
  const yOpen = (v) => padT + plotH - (v / maxOpen) * plotH;
  const xCenter = (i) => padL + groupW * i + groupW / 2;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`, width: "100%", height: String(H), class: "tp-svg", role: "img",
  });

  // horizontal gridlines + left axis labels (bar scale)
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((maxBar / ticks) * i);
    const y = yBar(v);
    svg.appendChild(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "tp-grid" }));
    const lbl = svgEl("text", { x: padL - 6, y: y + 3, class: "tp-axis tp-axis-l" });
    lbl.textContent = String(v);
    svg.appendChild(lbl);
  }
  // right axis max label (open/burndown scale)
  const rMax = svgEl("text", { x: W - padR + 6, y: yOpen(maxOpen) + 3, class: "tp-axis tp-axis-r" });
  rMax.textContent = String(maxOpen);
  svg.appendChild(rMax);

  // paired bars
  const barW = Math.max(2, Math.min(14, groupW * 0.32));
  const gap = Math.max(1, groupW * 0.06);
  const showEveryLabel = n <= 14 ? 1 : Math.ceil(n / 14);
  series.forEach((d, i) => {
    const cx = xCenter(i);
    const xC = cx - barW - gap / 2;
    const xA = cx + gap / 2;

    if (d.created > 0) {
      const y = yBar(d.created);
      const r = svgEl("rect", { x: xC, y, width: barW, height: padT + plotH - y, rx: 2, class: "tp-bar tp-bar-c" });
      r.appendChild(svgEl("title", {})).textContent = `${d.key} · 创建 ${d.created}`;
      svg.appendChild(r);
      const vl = svgEl("text", { x: xC + barW / 2, y: Math.max(9, y - 3), class: "tp-val tp-val-c" });
      vl.textContent = String(d.created);
      svg.appendChild(vl);
    }
    if (d.archived > 0) {
      const y = yBar(d.archived);
      const r = svgEl("rect", { x: xA, y, width: barW, height: padT + plotH - y, rx: 2, class: "tp-bar tp-bar-a" });
      r.appendChild(svgEl("title", {})).textContent = `${d.key} · 归档 ${d.archived}`;
      svg.appendChild(r);
      const vl = svgEl("text", { x: xA + barW / 2, y: Math.max(9, y - 3), class: "tp-val tp-val-a" });
      vl.textContent = String(d.archived);
      svg.appendChild(vl);
    }
    // x label (thinned to avoid crowding)
    if (i % showEveryLabel === 0) {
      const t = svgEl("text", { x: cx, y: H - padB + 16, class: "tp-axis tp-axis-x" });
      t.textContent = bucketLabel(d.key);
      svg.appendChild(t);
    }
  });

  // burndown line: open tasks over time (soft area fill underneath for depth)
  const base = padT + plotH;
  const linePts = series.map((d, i) => `${xCenter(i)},${yOpen(d.open)}`);
  const areaPts = `${xCenter(0)},${base} ${linePts.join(" ")} ${xCenter(n - 1)},${base}`;
  svg.appendChild(svgEl("polygon", { points: areaPts, class: "tp-area" }));
  svg.appendChild(svgEl("polyline", { points: linePts.join(" "), class: "tp-line" }));
  series.forEach((d, i) => {
    const cx = xCenter(i);
    const cy = yOpen(d.open);
    const dot = svgEl("circle", { cx, cy, r: 2.6, class: "tp-dot" });
    dot.appendChild(svgEl("title", {})).textContent = `${d.key} · 未完成 ${d.open}`;
    svg.appendChild(dot);
    // label only where the line moves (or the last point) to keep it readable
    const changed = i === 0 || d.open !== series[i - 1].open;
    if ((changed || i === n - 1) && d.open > 0) {
      const lbl = svgEl("text", { x: cx, y: Math.max(9, cy - 6), class: "tp-val tp-val-o" });
      lbl.textContent = String(d.open);
      svg.appendChild(lbl);
    }
  });

  host.replaceChildren(svg);
  renderLaneBar();
}

/* ── notes formatting ────────────────────────────────────── */
// split a note into { kind, label, body } where kind drives styling
function parseNote(text) {
  let m;
  if ((m = text.match(/^\[digest\]\s*(.*)$/s))) return { kind: "digest", label: "digest", body: m[1] };
  if ((m = text.match(/^\[session\s+([^\]]+)\]\s*(.*)$/s))) return { kind: "session", label: m[1], body: m[2] };
  if ((m = text.match(/^\[([^\]]+)\]\s*(.*)$/s))) return { kind: "tagged", label: m[1], body: m[2] };
  return { kind: "plain", label: null, body: text };
}

const escHtml = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

// inline markdown → html (on a single line of text, already HTML-escaped downstream)
// order matters: protect code spans first, then links/bold/italic, then domain highlights
function mdInline(raw) {
  let s = escHtml(raw);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_, t, u) => `<a href="${escHtml(u)}" target="_blank" rel="noopener">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  // domain highlights on remaining plain text
  s = s
    .replace(/\b([0-9a-f]{7,40})\b/g, '<span class="hl-commit">$1</span>')
    .replace(/\b(T\d{6}-\d{2})\b/g, '<span class="hl-id">$1</span>')
    .replace(/([\w./-]+\.(?:go|ts|tsx|md|json|js|py|csv))\b/g, '<span class="hl-path">$1</span>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escHtml(codes[+i])}</code>`);
  return s;
}

// minimal block-level markdown → html (headings, lists, quotes, code fences, hr, paragraphs)
function mdToHtml(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(mdInline).join("<br>")}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${mdInline(i)}</li>`).join("")}</${list.type}>`); list = null; }
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    // fenced code block
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      out.push(`<pre><code>${escHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      out.push(`<h${m[1].length} class="md-h">${mdInline(m[2])}</h${m[1].length}>`);
      continue;
    }
    if (/^\s*([-*+])\s+/.test(line)) {
      flushPara();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(line.replace(/^\s*[-*+]\s+/, ""));
      continue;
    }
    if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      flushPara();
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      flushPara(); flushList();
      out.push(`<blockquote>${mdInline(m[1])}</blockquote>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(); flushList(); out.push("<hr>"); continue;
    }
    para.push(line);
  }
  flushPara(); flushList();
  return out.join("");
}

// render a note body as markdown into host
function renderNoteBody(host, body) {
  const md = el("div", "md");
  md.innerHTML = mdToHtml(body);
  host.appendChild(md);
}

/* ── drawer ──────────────────────────────────────────────── */
function openDrawer(id) {
  if (!fillDrawer(id)) return;
  openTaskId = id;
  $("drawer").classList.add("show");
  $("drawer").setAttribute("aria-hidden", "false");
  $("scrim").classList.add("show");
}

function fillDrawer(id) {
  const t = LAST?.tasks.find((x) => x.id === id);
  if (!t) return false;
  const inner = $("drawerInner");
  inner.innerHTML = "";

  inner.appendChild(el("div", "dh-id", t.id));
  inner.appendChild(el("div", "dh-title", t.title));

  const meta = el("div", "dh-meta");
  const stateColors = { inbox: "var(--inbox)", processing: "var(--processing)", backlog: "var(--backlog)", archived: "var(--archived)" };
  const stateKv = el("div", "kv state");
  stateKv.style.setProperty("--scol", stateColors[t.state] || "var(--muted)");
  stateKv.innerHTML = `<b>${esc(t.state)}</b>`;
  meta.appendChild(stateKv);
  if (t.repo) { const k = el("div", "kv"); k.innerHTML = `repo <b>${esc(t.repo)}</b>`; meta.appendChild(k); }
  const et = t.effective_target;
  if (et && et.value) {
    const k = el("div", "kv");
    k.innerHTML = `target <b>${esc(et.value)}</b>${et.derived ? " <span style='color:var(--faint)'>(derived)</span>" : ""}`;
    meta.appendChild(k);
  }
  inner.appendChild(meta);

  if (t.tags.length) {
    const tagWrap = el("div", "c-meta");
    tagWrap.style.marginBottom = "20px";
    for (const g of t.tags) {
      const cls = g.startsWith("lane:") ? "chip lane" : g.startsWith("awaiting:") ? "chip awaiting" : "chip";
      tagWrap.appendChild(el("span", cls, g));
    }
    inner.appendChild(tagWrap);
  }

  if (t.ref) {
    const a = document.createElement("a");
    a.className = "dh-ref"; a.href = t.ref; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "↗ " + t.ref;
    inner.appendChild(a);
  }
  if (t.handoff_path) {
    const h = el("div", "kv"); h.style.marginBottom = "20px";
    h.innerHTML = `handoff <b>${esc(t.handoff_path)}</b>`;
    inner.appendChild(h);
  }

  // notes — formatted cards
  const notesTitle = el("div", "sec-title");
  notesTitle.innerHTML = `进度 notes <span class="n">${t.notes.length}</span>`;
  inner.appendChild(notesTitle);
  if (t.notes.length) {
    const wrap = el("div", "notes");
    // newest first reads better in a drawer
    for (const n of [...t.notes].reverse()) {
      const p = parseNote(n.text);
      const card = el("div", "note note-" + p.kind);
      const head = el("div", "note-head");
      const labels = el("div", "note-labels");
      const badge = el("span", "note-badge note-badge-" + p.kind, p.kind === "digest" ? "digest" : p.label || "note");
      labels.appendChild(badge);
      head.appendChild(labels);
      head.appendChild(el("span", "note-time", fmtTime(n.at)));
      card.appendChild(head);
      renderNoteBody(card, p.body);
      wrap.appendChild(card);
    }
    inner.appendChild(wrap);
  } else {
    inner.appendChild(el("div", "empty-note", "暂无 note"));
  }

  // sessions — full uuid + dir + copyable resume command
  const sessTitle = el("div", "sec-title");
  sessTitle.innerHTML = `关联 sessions <span class="n">${t.sessions.length}</span>`;
  inner.appendChild(sessTitle);
  if (t.sessions.length) {
    for (const s of t.sessions) {
      const row = el("div", "sess");
      const top = el("div", "sess-top");
      top.appendChild(el("span", "s-agent", s.agent || "cc"));
      top.appendChild(el("span", "s-time", fmtTime(s.started_at)));
      row.appendChild(top);

      // full uuid, click to copy
      row.appendChild(copyLine("uuid", s.uuid, s.uuid));

      if (s.transcript_path) {
        row.appendChild(el("div", "sess-dir", "file: " + s.transcript_path));
      }
      inner.appendChild(row);
    }
  } else {
    inner.appendChild(el("div", "empty-note", "暂无关联 session"));
  }
  return true;
}

// a labeled line with click-to-copy
function copyLine(label, display, copyVal) {
  const line = el("div", "copy-line");
  line.appendChild(el("span", "copy-label", label));
  const code = el("code", "copy-val", display);
  line.appendChild(code);
  const btn = el("button", "copy-btn", "copy");
  btn.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(copyVal).then(() => {
      btn.textContent = "copied";
      btn.classList.add("ok");
      setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("ok"); }, 1400);
    });
  };
  line.appendChild(btn);
  return line;
}

function closeDrawer() {
  openTaskId = null;
  $("drawer").classList.remove("show");
  $("drawer").setAttribute("aria-hidden", "true");
  $("scrim").classList.remove("show");
}

$("scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// throughput range toggle (按日 / 按周)
$("rangeToggle")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  const r = btn.dataset.range;
  if (!r || r === chartRange) return;
  chartRange = r;
  for (const b of $("rangeToggle").querySelectorAll(".seg-btn")) {
    b.classList.toggle("is-on", b.dataset.range === r);
  }
  renderThroughput();
});

// re-render chart on resize (SVG is sized to the container's pixel width)
let resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(renderThroughput, 150);
});

// "updated Ns ago" ticker
setInterval(() => {
  if (!lastFetchTs) return;
  const s = Math.round((Date.now() - lastFetchTs) / 1000);
  $("updated").textContent = s < 2 ? "just now" : `updated ${s}s ago`;
}, 1000);

load();
setInterval(load, 5000);
