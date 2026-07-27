// Money Tracker — app logic
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ---------- config gate ---------- */
const cfg = window.MT_CONFIG || {};
const configured = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !String(cfg.SUPABASE_URL).includes("PASTE");
const $ = (id) => document.getElementById(id);

if (!configured) {
  $("screen-setup").classList.remove("hidden");
  throw new Error("Money Tracker: fill in config.js first");
}

const supa = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

/* ---------- constants ---------- */
const CATEGORIES = [
  { name: "Food & Drinks", v: "--cat-1", e: "🍜" },
  { name: "Groceries", v: "--cat-2", e: "🛒" },
  { name: "Transport", v: "--cat-3", e: "⛽" },
  { name: "Shopping", v: "--cat-4", e: "🛍️" },
  { name: "Bills & Utilities", v: "--cat-5", e: "💡" },
  { name: "Health", v: "--cat-6", e: "💊" },
  { name: "Leisure & Travel", v: "--cat-7", e: "✈️" },
  { name: "Other", v: "--cat-8", e: "🧾" },
];
const catOf = (name) => CATEGORIES.find((c) => c.name === name) || CATEGORIES[7];
const catVar = (name) => catOf(name).v;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ---------- state ---------- */
let session = null;
let profile = null, household = null, members = [], txs = [], budgets = [];
let scope = "mine";
let view = "home";
let bdCat = "All", bdSort = "recent", bdSearch = "";
let reviewDrafts = [];
let chatMsgs = []; // {role, content}
let signupMode = false;

/* ---------- tiny helpers ---------- */
const fmtRM = (n) => "RM " + Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthKeyOf = (d) => String(d || "").slice(0, 7);
const thisMonthKey = () => todayISO().slice(0, 7);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => {
  if (!iso) return "no date";
  const d = new Date(iso + "T00:00:00");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date().getFullYear() ? " " + d.getFullYear() : ""}`;
};
const memberName = (uid) => (members.find((m) => m.id === uid) || {}).display_name || (uid === session?.user?.id ? "Me" : "Someone");

let heroAnim;
function countUp(el, target) {
  cancelAnimationFrame(heroAnim);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || target <= 0) {
    el.textContent = fmtRM(target);
    return;
  }
  const t0 = performance.now(), dur = 700;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    el.textContent = fmtRM(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) heroAnim = requestAnimationFrame(step);
  };
  heroAnim = requestAnimationFrame(step);
}

function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const EMO = ["🎉", "💸", "🪙", "✨"];
  for (let i = 0; i < 18; i++) {
    const b = document.createElement("span");
    b.className = "confetti-bit";
    b.textContent = EMO[i % EMO.length];
    b.style.left = (6 + Math.random() * 88) + "vw";
    b.style.top = (8 + Math.random() * 22) + "vh";
    b.style.animationDelay = (Math.random() * 0.3) + "s";
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 1900);
  }
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------- tooltip (charts) ---------- */
const tip = $("viz-tooltip");
function bindTip(el, text) {
  const show = (e) => {
    tip.textContent = text;
    tip.classList.remove("hidden");
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    tip.style.left = Math.min(x + 10, window.innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = (y - 34) + "px";
  };
  el.addEventListener("mousemove", show);
  el.addEventListener("mouseleave", () => tip.classList.add("hidden"));
  el.addEventListener("touchstart", (e) => { show(e); setTimeout(() => tip.classList.add("hidden"), 1600); }, { passive: true });
}

/* ---------- theme ---------- */
const themeBtn = $("theme-btn");
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("mt_theme", t);
  themeBtn.textContent = t === "dark" ? "🌞" : "🌙";
  document.getElementById("meta-theme").setAttribute("content", t === "dark" ? "#171511" : "#F6F1E7");
}
applyTheme(localStorage.getItem("mt_theme") || "light");
themeBtn.addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
);

/* ---------- auth ---------- */
$("auth-toggle").addEventListener("click", () => {
  signupMode = !signupMode;
  $("auth-name-row").classList.toggle("hidden", !signupMode);
  $("auth-submit").textContent = signupMode ? "Create account" : "Sign in";
  $("auth-toggle").textContent = signupMode ? "Have an account? Sign in" : "New here? Create an account";
  $("auth-error").classList.add("hidden");
});

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("auth-email").value.trim();
  const pass = $("auth-pass").value;
  const btn = $("auth-submit");
  btn.disabled = true;
  $("auth-error").classList.add("hidden");
  try {
    if (signupMode) {
      const name = $("auth-name").value.trim() || "Someone";
      const { error } = await supa.auth.signUp({ email, password: pass, options: { data: { display_name: name } } });
      if (error) throw error;
      const { error: e2 } = await supa.auth.signInWithPassword({ email, password: pass });
      if (e2) throw new Error("Account created — but sign-in needs email confirmation. Check your inbox (or disable 'Confirm email' in Supabase auth settings).");
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password: pass });
      if (error) throw new Error("Wrong email or password.");
    }
  } catch (err) {
    $("auth-error").textContent = err.message || String(err);
    $("auth-error").classList.remove("hidden");
  }
  btn.disabled = false;
});

$("sign-out").addEventListener("click", async () => {
  await supa.auth.signOut();
  chatMsgs = [];
  location.reload();
});

supa.auth.onAuthStateChange((_event, sess) => {
  const had = !!session;
  session = sess;
  if (sess && !had) enterApp();
  if (!sess) {
    $("app").classList.add("hidden");
    $("screen-auth").classList.remove("hidden");
  }
});

/* ---------- data loading ---------- */
async function loadAll() {
  try {
    const uid = session.user.id;
    const [p, t, b] = await Promise.all([
      supa.from("profiles").select("*").eq("id", uid).single(),
      supa.from("transactions").select("*").order("tx_date", { ascending: false }).order("created_at", { ascending: false }),
      supa.from("budgets").select("*"),
    ]);
    if (p.error) throw p.error;
    profile = p.data;
    txs = t.data || [];
    budgets = b.data || [];
    household = null;
    members = [{ id: uid, display_name: profile.display_name }];
    if (profile.household_id) {
      const [h, m] = await Promise.all([
        supa.from("households").select("*").eq("id", profile.household_id).single(),
        supa.from("profiles").select("id, display_name").eq("household_id", profile.household_id),
      ]);
      household = h.data;
      if (m.data?.length) members = m.data;
    }
    localStorage.setItem("mt_cache", JSON.stringify({ profile, household, members, txs, budgets }));
  } catch (err) {
    const cached = localStorage.getItem("mt_cache");
    if (cached) {
      ({ profile, household, members, txs, budgets } = JSON.parse(cached));
      toast("Offline — showing saved data");
    } else {
      toast("Couldn't load your data. Check your connection.");
      console.error(err);
    }
  }
  $("scope-toggle").classList.toggle("hidden", !household);
  if (!household) scope = "mine";
}

async function enterApp() {
  $("screen-auth").classList.add("hidden");
  $("app").classList.remove("hidden");
  await loadAll();
  switchView("home");
}

/* ---------- scope + nav ---------- */
const visibleTxs = () => (scope === "mine" ? txs.filter((t) => t.user_id === session.user.id) : txs);

document.querySelectorAll(".scope-btn").forEach((b) =>
  b.addEventListener("click", () => {
    scope = b.dataset.scope;
    document.querySelectorAll(".scope-btn").forEach((x) => x.classList.toggle("active", x === b));
    renderCurrent();
  })
);

const VIEW_TITLES = { home: "Home", breakdown: "Breakdown", add: "Add", chat: "Chat", settings: "Settings" };
function switchView(v) {
  view = v;
  document.querySelectorAll(".view").forEach((s) => s.classList.add("hidden"));
  $("view-" + v).classList.remove("hidden");
  $("topbar-title").textContent = VIEW_TITLES[v];
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  $("chat-inputbar").classList.toggle("hidden", v !== "chat");
  renderCurrent();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".nav-btn, .nav-add").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.goto)));

function renderCurrent() {
  if (view === "home") renderHome();
  if (view === "breakdown") renderBreakdown();
  if (view === "add") renderAddIdle();
  if (view === "chat") renderChat();
  if (view === "settings") renderSettings();
}

/* ================= HOME ================= */
function renderHome() {
  const list = visibleTxs();
  const mk = thisMonthKey();
  const monthTxs = list.filter((t) => monthKeyOf(t.tx_date) === mk);
  const total = monthTxs.reduce((s, t) => s + Number(t.total), 0);

  $("hero-label").textContent = scope === "ours" ? "We spent this month" : "Spent this month";
  countUp($("hero-amount"), total);

  // delta vs last month
  const last = new Date(); last.setDate(1); last.setMonth(last.getMonth() - 1);
  const lastKey = last.toISOString().slice(0, 7);
  const lastTotal = list.filter((t) => monthKeyOf(t.tx_date) === lastKey).reduce((s, t) => s + Number(t.total), 0);
  const deltaEl = $("hero-delta");
  deltaEl.className = "hero-delta";
  if (lastTotal > 0) {
    const diff = total - lastTotal;
    if (diff <= 0) { deltaEl.textContent = `↓ ${fmtRM(-diff)} less than ${MONTHS[last.getMonth()]}`; deltaEl.classList.add("down"); }
    else deltaEl.textContent = `↑ ${fmtRM(diff)} more than ${MONTHS[last.getMonth()]}`;
  } else {
    deltaEl.textContent = monthTxs.length ? "First month tracked" : "Add your first receipt to get started";
  }

  renderDonut(monthTxs, total);
  renderTrend(list);
  renderBudgets();
  renderTopMerchants(monthTxs);
  renderMonthReceipt(monthTxs, total);
}

function renderDonut(monthTxs, total) {
  const holder = $("donut-holder"), legend = $("donut-legend");
  const byCat = CATEGORIES.map((c) => ({
    ...c,
    sum: monthTxs.filter((t) => t.category === c.name).reduce((s, t) => s + Number(t.total), 0),
  })).filter((c) => c.sum > 0).sort((a, b) => b.sum - a.sum);

  if (!byCat.length) {
    holder.innerHTML = "";
    legend.innerHTML = `<li class="empty-note" style="padding:12px 0">Nothing yet this month.</li>`;
    return;
  }

  const R = 44, SW = 18, C = 2 * Math.PI * R, GAP = 2.5;
  let offset = 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("width", "128"); svg.setAttribute("height", "128");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Spending by category this month");
  byCat.forEach((c) => {
    const frac = c.sum / total;
    const seg = Math.max(frac * C - (byCat.length > 1 ? GAP : 0), 1.5);
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", 60); circle.setAttribute("cy", 60); circle.setAttribute("r", R);
    circle.setAttribute("fill", "none");
    circle.style.stroke = `var(${c.v})`;
    circle.setAttribute("stroke-width", SW);
    circle.setAttribute("stroke-dasharray", `${seg} ${C - seg}`);
    circle.setAttribute("stroke-dashoffset", String(C / 4 - offset));
    svg.appendChild(circle);
    bindTip(circle, `${c.name} · ${fmtRM(c.sum)} · ${Math.round(frac * 100)}%`);
    offset += frac * C;
  });
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", 60); label.setAttribute("y", 58);
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("class", "donut-center-label");
  label.setAttribute("style", "font-size:9px;fill:var(--muted);font-weight:600");
  label.textContent = "this month";
  const label2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label2.setAttribute("x", 60); label2.setAttribute("y", 70);
  label2.setAttribute("text-anchor", "middle");
  label2.setAttribute("style", `font-size:10px;fill:var(--ink);font-weight:600;font-family:var(--font-mono)`);
  label2.textContent = total >= 10000 ? "RM " + (total / 1000).toFixed(1) + "k" : fmtRM(total).replace(".00", "");
  svg.appendChild(label); svg.appendChild(label2);
  holder.innerHTML = ""; holder.appendChild(svg);

  legend.innerHTML = byCat.map((c) => `
    <li><span class="legend-dot" style="background:var(${c.v})"></span>
    <span class="legend-name">${esc(c.name)}</span>
    <span class="legend-val mono">${fmtRM(c.sum)}</span></li>`).join("");
}

function renderTrend(list) {
  const holder = $("trend-holder");
  const now = new Date();
  const monthsArr = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthsArr.push({ key, label: MONTHS[d.getMonth()], sum: 0 });
  }
  list.forEach((t) => {
    const m = monthsArr.find((x) => x.key === monthKeyOf(t.tx_date));
    if (m) m.sum += Number(t.total);
  });
  const max = Math.max(...monthsArr.map((m) => m.sum), 1);

  const W = 320, H = 150, PAD = 10, baseY = H - 24, topY = 26;
  const bw = 30, gap = (W - PAD * 2 - bw * 6) / 5;
  let bars = "";
  monthsArr.forEach((m, i) => {
    const x = PAD + i * (bw + gap);
    const h = Math.max((m.sum / max) * (baseY - topY), m.sum > 0 ? 3 : 0);
    const y = baseY - h;
    if (m.sum > 0) {
      const r = Math.min(4, h);
      bars += `<path class="trend-bar" data-i="${i}" d="M${x},${baseY} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${baseY} Z" style="fill:var(--trend)"/>`;
    }
    if (i === 5 && m.sum > 0) {
      const vLabel = m.sum >= 10000 ? (m.sum / 1000).toFixed(1) + "k" : Math.round(m.sum).toLocaleString();
      bars += `<text class="bar-value" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${vLabel}</text>`;
    }
    bars += `<text class="axis-label" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${m.label}</text>`;
  });
  holder.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending, last six months">
    <line class="gridline" x1="${PAD}" y1="${baseY}" x2="${W - PAD}" y2="${baseY}"/>${bars}</svg>`;
  holder.querySelectorAll(".trend-bar").forEach((p) => {
    const m = monthsArr[Number(p.dataset.i)];
    bindTip(p, `${m.label} · ${fmtRM(m.sum)}`);
  });
}

function renderBudgets() {
  const holder = $("budget-bars");
  const myMonth = txs.filter((t) => t.user_id === session.user.id && monthKeyOf(t.tx_date) === thisMonthKey());
  const active = budgets.filter((b) => Number(b.monthly_limit) > 0);
  if (!active.length) {
    holder.innerHTML = `<p class="muted">No budgets yet. Set a monthly limit per category and I'll keep an eye on it.</p>`;
    return;
  }
  holder.innerHTML = active.map((b) => {
    const spent = myMonth.filter((t) => t.category === b.category).reduce((s, t) => s + Number(t.total), 0);
    const ratio = spent / Number(b.monthly_limit);
    const cls = ratio > 1 ? "crit" : ratio >= 0.8 ? "warn" : "";
    const note = ratio > 1
      ? `<div class="budget-note crit">⚠ over by ${fmtRM(spent - b.monthly_limit)}</div>`
      : ratio >= 0.8
        ? `<div class="budget-note warn">◔ ${fmtRM(b.monthly_limit - spent)} left — nearly there</div>`
        : "";
    return `<div class="budget-row">
      <div class="budget-head"><span class="b-name">${catOf(b.category).e} ${esc(b.category)}</span>
      <span class="spent mono">${fmtRM(spent)} / ${fmtRM(b.monthly_limit)}</span></div>
      <div class="budget-track"><div class="budget-fill ${cls}" style="--p:${Math.min(ratio, 1)}"></div></div>
      ${note}</div>`;
  }).join("");
}

function renderTopMerchants(monthTxs) {
  const holder = $("top-merchants");
  const by = {};
  monthTxs.forEach((t) => {
    const k = t.merchant;
    by[k] = by[k] || { sum: 0, n: 0 };
    by[k].sum += Number(t.total); by[k].n++;
  });
  const top = Object.entries(by).sort((a, b) => b[1].sum - a[1].sum).slice(0, 3);
  holder.innerHTML = top.length
    ? top.map(([name, d], i) => `<div class="merchant-row">
        <span class="m-rank">${["🥇", "🥈", "🥉"][i]}</span>
        <span class="m-mid"><span class="m-name">${esc(name)}</span><br><span class="m-sub">${d.n} visit${d.n > 1 ? "s" : ""}</span></span>
        <span class="m-amt mono">${fmtRM(d.sum)}</span></div>`).join("")
    : `<p class="muted">No spending yet this month.</p>`;
}

function renderMonthReceipt(monthTxs, total) {
  const el = $("month-receipt");
  if (!monthTxs.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const now = new Date();
  const days = new Set(monthTxs.map((t) => t.tx_date)).size;
  const biggest = monthTxs.reduce((a, b) => (Number(b.total) > Number(a.total) ? b : a));
  const byCat = {};
  monthTxs.forEach((t) => { byCat[t.category] = (byCat[t.category] || 0) + Number(t.total); });
  const catLines = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([c, s]) => `<div class="r-line"><span>${esc(c)}</span><span>${fmtRM(s)}</span></div>`).join("");
  el.innerHTML = `
    <h3>· ${MONTHS[now.getMonth()]} ${now.getFullYear()} summary ·</h3>
    <div class="r-line"><span>entries</span><span>${monthTxs.length}</span></div>
    <div class="r-line"><span>days with spending</span><span>${days}</span></div>
    <div class="r-line"><span>biggest: ${esc(biggest.merchant)}</span><span>${fmtRM(biggest.total)}</span></div>
    <div class="r-rule"></div>
    ${catLines}
    <div class="r-rule"></div>
    <div class="r-line r-total"><span>TOTAL</span><span>${fmtRM(total)}</span></div>
    <div class="r-foot">— thank you, come again —</div>`;
}

/* ================= BREAKDOWN ================= */
$("bd-search").addEventListener("input", (e) => { bdSearch = e.target.value.toLowerCase(); renderBdList(); });
$("bd-sort").addEventListener("change", (e) => { bdSort = e.target.value; renderBdList(); });

function renderBreakdown() {
  const chips = $("cat-chips");
  const names = ["All", ...CATEGORIES.map((c) => c.name)];
  chips.innerHTML = names.map((n) => {
    const c = n === "All" ? null : catOf(n);
    return `<button class="chip ${n === "All" ? "chip-all" : ""} ${bdCat === n ? "active" : ""}"
      ${c ? `style="--cc:var(${c.v})"` : ""} data-cat="${esc(n)}">${c ? c.e : "✨"} ${esc(n)}</button>`;
  }).join("");
  chips.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => { bdCat = c.dataset.cat; renderBreakdown(); })
  );
  renderBdList();
}

function renderBdList() {
  let list = visibleTxs();
  if (bdCat !== "All") list = list.filter((t) => t.category === bdCat);
  if (bdSearch) {
    list = list.filter((t) =>
      (t.merchant || "").toLowerCase().includes(bdSearch) ||
      (t.notes || "").toLowerCase().includes(bdSearch) ||
      (t.items || []).some((i) => (i.name || "").toLowerCase().includes(bdSearch))
    );
  }
  list = [...list];
  if (bdSort === "recent") list.sort((a, b) => (b.tx_date || "").localeCompare(a.tx_date || ""));
  if (bdSort === "added") list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  if (bdSort === "high") list.sort((a, b) => Number(b.total) - Number(a.total));
  if (bdSort === "low") list.sort((a, b) => Number(a.total) - Number(b.total));

  const sum = list.reduce((s, t) => s + Number(t.total), 0);
  $("bd-summary").textContent = list.length
    ? `${list.length} entr${list.length === 1 ? "y" : "ies"} · ${fmtRM(sum)}${bdCat !== "All" ? " · " + bdCat : ""}`
    : "";

  const holder = $("bd-list");
  if (!list.length) {
    holder.innerHTML = `<p class="empty-note"><span class="big">${bdSearch || bdCat !== "All" ? "🔍" : "🌱"}</span>${bdSearch || bdCat !== "All" ? "Nothing matches. Try another category or search." : "No spending saved yet. Tap + to add your first."}</p>`;
    return;
  }
  holder.innerHTML = list.map((t) => `
    <button class="tx-row" data-id="${t.id}">
      <span class="cat-badge" style="--cc:var(${catVar(t.category)})">${catOf(t.category).e}</span>
      <span class="tx-mid">
        <span class="tx-merchant">${esc(t.merchant)}</span><br>
        <span class="tx-sub">${fmtDate(t.tx_date)} · ${esc(t.category)}${scope === "ours" && members.length > 1 ? " · " + esc(memberName(t.user_id)) : ""}</span>
      </span>
      <span class="tx-amt mono">${fmtRM(t.total)}</span>
    </button>`).join("");
  holder.querySelectorAll(".tx-row").forEach((r) =>
    r.addEventListener("click", () => openTxModal(txs.find((t) => t.id === r.dataset.id)))
  );
}

/* ---------- transaction modal ---------- */
function openTxModal(tx) {
  if (!tx) return;
  const own = tx.user_id === session.user.id;
  const modal = $("modal-tx");
  const items = (tx.items || []);
  modal.innerHTML = `
    <div class="modal-title"><span>${catOf(tx.category).e}</span>${esc(tx.merchant)}</div>
    <div class="modal-sub">${fmtDate(tx.tx_date)} · ${esc(tx.source)} · added by ${esc(memberName(tx.user_id))}</div>
    ${own ? `
    <div class="review-grid">
      <div><label>Date</label><input type="date" id="m-date" value="${esc(tx.tx_date || "")}"></div>
      <div><label>Total (RM)</label><input type="number" step="0.01" min="0" id="m-total" value="${Number(tx.total)}"></div>
      <div class="span2"><label>Place</label><input type="text" id="m-merchant" value="${esc(tx.merchant)}"></div>
      <div><label>Category</label><select id="m-cat">${CATEGORIES.map((c) => `<option value="${c.name}" ${c.name === tx.category ? "selected" : ""}>${c.e} ${c.name}</option>`).join("")}</select></div>
      <div><label>Paid with</label><input type="text" id="m-pay" value="${esc(tx.payment_method || "")}" placeholder="Cash, card…"></div>
      <div class="span2"><label>Notes</label><input type="text" id="m-notes" value="${esc(tx.notes || "")}"></div>
    </div>` : `
    <p><strong class="mono">${fmtRM(tx.total)}</strong> · ${esc(tx.category)}${tx.payment_method ? " · " + esc(tx.payment_method) : ""}</p>
    ${tx.notes ? `<p class="muted">${esc(tx.notes)}</p>` : ""}`}
    ${items.length ? `<table class="items-table">${items.map((i) => `
      <tr><td class="qty">${Number(i.qty) || 1}×</td><td>${esc(i.name)}</td><td>${fmtRM(i.price)}</td></tr>`).join("")}</table>` : ""}
    <div class="modal-actions">
      ${own ? `<button class="btn btn-primary" id="m-save">Save changes</button>
               <button class="btn btn-ghost" id="m-delete">Delete</button>` : ""}
      <button class="btn btn-ghost" id="m-close">Close</button>
    </div>`;
  $("modal-overlay").classList.remove("hidden");
  $("m-close").addEventListener("click", closeModal);
  if (own) {
    $("m-save").addEventListener("click", async () => {
      const patch = {
        tx_date: $("m-date").value || tx.tx_date,
        total: Number($("m-total").value) || tx.total,
        merchant: $("m-merchant").value.trim() || tx.merchant,
        category: $("m-cat").value,
        payment_method: $("m-pay").value.trim() || null,
        notes: $("m-notes").value.trim() || null,
      };
      const { error } = await supa.from("transactions").update(patch).eq("id", tx.id);
      if (error) return toast("Couldn't save — try again");
      Object.assign(tx, patch);
      closeModal(); renderCurrent(); toast("Updated");
    });
    $("m-delete").addEventListener("click", async () => {
      if (!confirm(`Delete ${tx.merchant} (${fmtRM(tx.total)})? This can't be undone.`)) return;
      const { error } = await supa.from("transactions").delete().eq("id", tx.id);
      if (error) return toast("Couldn't delete — try again");
      txs = txs.filter((t) => t.id !== tx.id);
      closeModal(); renderCurrent(); toast("Deleted");
    });
  }
}
function closeModal() { $("modal-overlay").classList.add("hidden"); }
$("modal-overlay").addEventListener("click", (e) => { if (e.target === $("modal-overlay")) closeModal(); });

/* ================= ADD ================= */
function renderAddIdle() {
  $("add-choices").classList.remove("hidden");
  $("add-processing").classList.add("hidden");
  $("add-review").classList.add("hidden");
}
$("add-camera").addEventListener("click", () => $("file-camera").click());
$("add-gallery").addEventListener("click", () => $("file-gallery").click());
$("file-camera").addEventListener("change", (e) => handleFiles([...e.target.files]));
$("file-gallery").addEventListener("change", (e) => handleFiles([...e.target.files].slice(0, 6)));
$("add-manual").addEventListener("click", () => {
  reviewDrafts = [blankDraft()];
  showReview("Type it in");
});

const blankDraft = () => ({
  tx_date: todayISO(), merchant: "", total: "", category: "Other",
  payment_method: "", source: "manual", items: [], notes: "",
});

async function downscale(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej; i.src = url;
    });
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function handleFiles(files) {
  if (!files.length) return;
  $("file-camera").value = ""; $("file-gallery").value = "";
  $("add-choices").classList.add("hidden");
  $("add-processing").classList.remove("hidden");
  $("add-processing-text").textContent = files.length > 1 ? `Reading ${files.length} photos…` : "Reading your receipt…";
  try {
    const images = await Promise.all(files.map(downscale));
    const { data, error } = await supa.functions.invoke("extract", { body: { images } });
    if (error) {
      let msg = "Couldn't read the photo.";
      try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    const found = (data.transactions || []).map((t) => ({
      tx_date: t.tx_date || todayISO(),
      merchant: t.merchant || "",
      total: t.total ?? "",
      category: CATEGORIES.some((c) => c.name === t.category) ? t.category : "Other",
      payment_method: t.payment_method || "",
      source: t.source || "receipt",
      items: t.items || [],
      notes: t.notes || "",
    }));
    if (!found.length) {
      toast("Couldn't find any spending in that photo — you can type it in instead");
      reviewDrafts = [blankDraft()];
    } else {
      reviewDrafts = found;
    }
    showReview(found.length > 1 ? `Found ${found.length} transactions` : "Check & save");
  } catch (err) {
    toast(err.message || "Something went wrong — try again or type it in");
    renderAddIdle();
  }
}

function isDupe(d) {
  return txs.some((t) =>
    t.user_id === session.user.id &&
    t.merchant.toLowerCase() === String(d.merchant).toLowerCase() &&
    Number(t.total).toFixed(2) === Number(d.total).toFixed(2) &&
    t.tx_date === d.tx_date
  );
}

function showReview(heading) {
  $("add-choices").classList.add("hidden");
  $("add-processing").classList.add("hidden");
  $("add-review").classList.remove("hidden");
  $("review-heading").textContent = heading;
  const holder = $("review-cards");
  holder.innerHTML = reviewDrafts.map((d, i) => `
    <div class="receipt review-card" data-i="${i}">
      ${isDupe(d) ? `<div class="dupe-flag">Looks like a duplicate of one you already saved</div>` : ""}
      <div class="review-grid">
        <div class="span2"><label>Place</label><input type="text" data-f="merchant" value="${esc(d.merchant)}" placeholder="Where was this?"></div>
        <div><label>Date</label><input type="date" data-f="tx_date" value="${esc(d.tx_date)}"></div>
        <div><label>Total (RM)</label><input type="number" step="0.01" min="0" inputmode="decimal" data-f="total" value="${d.total}" placeholder="0.00"></div>
        <div><label>Category</label><select data-f="category">${CATEGORIES.map((c) => `<option value="${c.name}" ${c.name === d.category ? "selected" : ""}>${c.e} ${c.name}</option>`).join("")}</select></div>
        <div><label>Paid with</label><input type="text" data-f="payment_method" value="${esc(d.payment_method)}" placeholder="Cash, card…"></div>
        <div class="span2"><label>Notes</label><input type="text" data-f="notes" value="${esc(d.notes)}"></div>
      </div>
      ${d.items.length ? `<div class="review-items">${d.items.map((it) => `
        <div class="r-line"><span>${Number(it.qty) || 1}× ${esc(it.name)}</span><span>${fmtRM(it.price)}</span></div>`).join("")}</div>` : ""}
      ${reviewDrafts.length > 1 ? `<button class="btn-danger-link review-remove" data-i="${i}">Don't save this one</button>` : ""}
    </div>`).join("");

  holder.querySelectorAll("[data-f]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const card = inp.closest(".review-card");
      reviewDrafts[Number(card.dataset.i)][inp.dataset.f] = inp.value;
    });
  });
  holder.querySelectorAll(".review-remove").forEach((b) =>
    b.addEventListener("click", () => {
      reviewDrafts.splice(Number(b.dataset.i), 1);
      reviewDrafts.length ? showReview($("review-heading").textContent) : renderAddIdle();
    })
  );
  $("review-save-all").textContent = reviewDrafts.length > 1 ? `Save all ${reviewDrafts.length}` : "Save";
}

$("review-cancel").addEventListener("click", () => { reviewDrafts = []; renderAddIdle(); });
$("review-save-all").addEventListener("click", async () => {
  const rows = [];
  for (const d of reviewDrafts) {
    if (!String(d.merchant).trim()) return toast("Every entry needs a place name");
    const total = Number(d.total);
    if (!(total > 0)) return toast("Every entry needs an amount above zero");
    rows.push({
      user_id: session.user.id,
      tx_date: d.tx_date || todayISO(),
      merchant: String(d.merchant).trim(),
      total: total.toFixed(2),
      category: d.category,
      payment_method: String(d.payment_method).trim() || null,
      source: d.source,
      items: d.items,
      notes: String(d.notes).trim() || null,
    });
  }
  const btn = $("review-save-all");
  btn.disabled = true;
  const { data, error } = await supa.from("transactions").insert(rows).select();
  btn.disabled = false;
  if (error) return toast("Couldn't save — check your connection and try again");
  txs = [...data, ...txs];
  localStorage.setItem("mt_cache", JSON.stringify({ profile, household, members, txs, budgets }));
  reviewDrafts = [];
  toast(`Saved ${data.length} ${data.length === 1 ? "entry" : "entries"} ✓`);
  confetti();
  switchView("home");
});

/* ================= CHAT ================= */
const SUGGESTIONS = [
  "💥 What's my biggest spending this month?",
  "🍜 How much did I spend on food this month?",
  "📅 Compare this month with last month",
  "🔁 Any recurring charges I should know about?",
  "💳 What was my most expensive day?",
];

function renderChat() {
  const box = $("chat-messages");
  const wrapMsg = (m) => m.role === "user"
    ? `<div class="msg-row user"><div class="msg user">${esc(m.content)}</div></div>`
    : `<div class="msg-row"><span class="bot-avatar">💸</span><div class="msg bot">${esc(m.content)}</div></div>`;
  box.innerHTML = chatMsgs.map(wrapMsg).join("");
  const sug = $("chat-suggestions");
  if (!chatMsgs.length) {
    box.innerHTML = `<div class="msg-row"><span class="bot-avatar">💸</span><div class="msg bot">Hi! Ask me anything about your spending — where the money went, when you last visited a place, what's creeping up…</div></div>`;
    sug.innerHTML = SUGGESTIONS.map((s) => `<button class="chip">${esc(s)}</button>`).join("");
    sug.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => sendChat(c.textContent)));
  } else {
    sug.innerHTML = "";
  }
  box.scrollTop = box.scrollHeight;
  window.scrollTo(0, document.body.scrollHeight);
}

$("chat-send").addEventListener("click", () => sendChat($("chat-input").value));
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat($("chat-input").value); });

let chatBusy = false;
async function sendChat(text) {
  text = String(text || "").trim();
  if (!text || chatBusy) return;
  chatBusy = true;
  $("chat-input").value = "";
  chatMsgs.push({ role: "user", content: text });
  renderChat();
  const box = $("chat-messages");
  const typing = document.createElement("div");
  typing.className = "msg-row";
  typing.innerHTML = `<span class="bot-avatar">💸</span><div class="msg bot typing">thinking…</div>`;
  box.appendChild(typing);
  window.scrollTo(0, document.body.scrollHeight);
  try {
    const { data, error } = await supa.functions.invoke("chat", {
      body: { message: text, history: chatMsgs.slice(0, -1).slice(-8), scope },
    });
    if (error) {
      let msg = "The assistant is unavailable right now.";
      try { msg = (await error.context.json()).error || msg; } catch { /* keep default */ }
      throw new Error(msg);
    }
    chatMsgs.push({ role: "assistant", content: data.reply });
  } catch (err) {
    chatMsgs.push({ role: "assistant", content: err.message || "Something went wrong — try again." });
  }
  chatBusy = false;
  renderChat();
}

/* ================= SETTINGS ================= */
function renderSettings() {
  $("set-name").value = profile?.display_name || "";
  $("set-email").textContent = session.user.email;
  renderHouseholdCard();
  renderBudgetEditor();
  const mine = txs.filter((t) => t.user_id === session.user.id);
  const first = mine.length ? mine.reduce((a, b) => (a.tx_date < b.tx_date ? a : b)).tx_date : null;
  $("data-count").textContent = mine.length
    ? `${mine.length} entries of yours, since ${fmtDate(first)}.`
    : "Nothing saved yet.";
}

$("set-name-save").addEventListener("click", async () => {
  const name = $("set-name").value.trim();
  if (!name) return;
  const { error } = await supa.from("profiles").update({ display_name: name }).eq("id", session.user.id);
  if (error) return toast("Couldn't save the name");
  profile.display_name = name;
  const me = members.find((m) => m.id === session.user.id);
  if (me) me.display_name = name;
  toast("Name saved");
});

function renderHouseholdCard() {
  const card = $("card-household");
  if (household) {
    card.innerHTML = `
      <h2 class="card-title">Household — ${esc(household.name)}</h2>
      <p class="muted">Anyone with this code joins your household and shares an "Ours" view. Spending stays editable only by whoever added it.</p>
      <div class="invite-code">${esc(household.invite_code)}</div>
      ${members.map((m) => `<div class="member-row"><span class="member-dot"></span>${esc(m.display_name)}${m.id === session.user.id ? " (you)" : ""}</div>`).join("")}
      <button class="btn-danger-link" id="hh-leave" style="margin-top:10px">Leave household</button>`;
    $("hh-leave").addEventListener("click", async () => {
      if (!confirm("Leave this household? You'll keep your own spending; you just stop sharing views.")) return;
      const { error } = await supa.rpc("leave_household");
      if (error) return toast("Couldn't leave — try again");
      await loadAll(); renderSettings(); toast("Left the household");
    });
  } else {
    card.innerHTML = `
      <h2 class="card-title">Household</h2>
      <p class="muted">Share spending with your family: one of you creates a household, the rest join with the code.</p>
      <div class="field"><label for="hh-name">Start one</label>
        <div class="inline-field"><input id="hh-name" type="text" maxlength="40" placeholder="e.g. Our home"><button class="btn btn-small" id="hh-create">Create</button></div></div>
      <div class="field"><label for="hh-code">Or join with a code</label>
        <div class="inline-field"><input id="hh-code" type="text" maxlength="6" placeholder="ABC123" style="text-transform:uppercase"><button class="btn btn-small" id="hh-join">Join</button></div></div>`;
    $("hh-create").addEventListener("click", async () => {
      const name = $("hh-name").value.trim();
      if (!name) return toast("Give your household a name");
      const { data, error } = await supa.rpc("create_household", { hname: name });
      if (error) return toast("Couldn't create — try again");
      await loadAll(); renderSettings();
      toast(`Created! Share code ${data.invite_code}`);
    });
    $("hh-join").addEventListener("click", async () => {
      const code = $("hh-code").value.trim();
      if (!code) return;
      const { data, error } = await supa.rpc("join_household", { code });
      if (error || !data) return toast("No household with that code");
      await loadAll(); renderSettings();
      toast(`Joined ${data.name} 🎉`);
    });
  }
}

function renderBudgetEditor() {
  const holder = $("budget-editor");
  holder.innerHTML = CATEGORIES.map((c) => {
    const b = budgets.find((x) => x.category === c.name);
    return `<div class="budget-editor-row">
      <label><span class="chip-dot" style="width:8px;height:8px;border-radius:50%;background:var(${c.v})"></span>${esc(c.name)}</label>
      <input type="number" min="0" step="10" inputmode="decimal" data-cat="${esc(c.name)}" value="${b ? Number(b.monthly_limit) : ""}" placeholder="—">
    </div>`;
  }).join("");
}

$("budgets-save").addEventListener("click", async () => {
  const inputs = [...$("budget-editor").querySelectorAll("input")];
  const ups = [], dels = [];
  inputs.forEach((i) => {
    const v = Number(i.value);
    if (i.value !== "" && v > 0) ups.push({ user_id: session.user.id, category: i.dataset.cat, monthly_limit: v });
    else dels.push(i.dataset.cat);
  });
  if (ups.length) {
    const { error } = await supa.from("budgets").upsert(ups, { onConflict: "user_id,category" });
    if (error) return toast("Couldn't save budgets");
  }
  if (dels.length) await supa.from("budgets").delete().eq("user_id", session.user.id).in("category", dels);
  const { data } = await supa.from("budgets").select("*");
  budgets = data || [];
  toast("Budgets saved");
});

/* ---------- CSV export ---------- */
$("export-csv").addEventListener("click", () => {
  const list = visibleTxs();
  if (!list.length) return toast("Nothing to export yet");
  const head = "date,merchant,total_rm,category,payment_method,source,person,notes\n";
  const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const body = list.map((t) =>
    [t.tx_date, csvEsc(t.merchant), Number(t.total).toFixed(2), csvEsc(t.category),
     csvEsc(t.payment_method || ""), t.source, csvEsc(memberName(t.user_id)), csvEsc(t.notes || "")].join(",")
  ).join("\n");
  const blob = new Blob([head + body], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `money-tracker-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- boot ---------- */
(async () => {
  const { data } = await supa.auth.getSession();
  if (!data.session) $("screen-auth").classList.remove("hidden");
  // onAuthStateChange handles the rest
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is a nicety, not a need */ });
}
