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
const INCOME_CATS = [
  { name: "Salary", e: "💼" },
  { name: "Side income", e: "🪙" },
  { name: "Gift", e: "🎁" },
  { name: "Refund", e: "↩️" },
  { name: "Other income", e: "💰" },
];
const isExpense = (t) => (t.kind || "expense") === "expense";
const dispCat = (t) => isExpense(t)
  ? catOf(t.category)
  : { ...(INCOME_CATS.find((c) => c.name === t.category) || INCOME_CATS[4]), v: "--cat-6" };
// Offline fallback only — live rates load at startup and override these.
const FALLBACK_RATES = { MYR: 1, SGD: 3.3, USD: 4.2, EUR: 4.9, GBP: 5.7, THB: 0.13, IDR: 0.00027, JPY: 0.029, KRW: 0.0032, CNY: 0.59, TWD: 0.14, AUD: 2.9, VND: 0.00017, PHP: 0.075, INR: 0.05, HKD: 0.54 };
let RATES = { ...FALLBACK_RATES };
let ratesInfo = { live: false, date: null };
const CURRENCIES = Object.keys(FALLBACK_RATES);

// One free call a day; cached in localStorage, stale cache beats no rates.
async function loadRates() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem("mt_rates") || "null"); } catch { /* ignore */ }
  const useCache = () => {
    RATES = { ...FALLBACK_RATES, ...cached.rates };
    ratesInfo = { live: true, date: cached.date };
  };
  if (cached?.rates && Date.now() - cached.ts < 864e5) { useCache(); return; }
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/MYR", { cache: "no-store" });
    const j = await res.json();
    if (j.result !== "success" || !j.rates) throw new Error("bad payload");
    const fresh = { MYR: 1 };
    for (const code of CURRENCIES) {
      const perMyr = j.rates[code];
      if (typeof perMyr === "number" && perMyr > 0) fresh[code] = 1 / perMyr;
    }
    RATES = { ...FALLBACK_RATES, ...fresh };
    const date = (j.time_last_update_utc || "").slice(5, 16) || todayISO();
    ratesInfo = { live: true, date };
    localStorage.setItem("mt_rates", JSON.stringify({ ts: Date.now(), rates: fresh, date }));
  } catch {
    if (cached?.rates) useCache();
    else if (!ratesInfo.live) ratesInfo = { live: false, date: null };
  }
}
const origNote = (t) => t.orig_amount ? ` · ${t.currency} ${Number(t.orig_amount).toLocaleString()}` : "";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* ---------- state ---------- */
let session = null;
let profile = null, household = null, members = [], txs = [], budgets = [];
let scope = "mine";
let view = "home";
let bdCat = "All", bdSort = "recent", bdSearch = "";
let homeOffset = 0; // donut card month offset (0 = current)
let statsGran = "month", statsAnchor = new Date();
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
function applyTheme(t, persist = true) {
  document.documentElement.dataset.theme = t;
  if (persist) localStorage.setItem("mt_theme2", t);
  themeBtn.textContent = t === "dark" ? "🌞" : "🌙";
  document.getElementById("meta-theme").setAttribute("content", t === "dark" ? "#171511" : "#F6F1E7");
}
applyTheme(localStorage.getItem("mt_theme2") || "dark", false);
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

// Usernames ride on Supabase email auth: username -> hidden synthetic email.
// Short passwords get deterministic padding to clear Supabase's 6-char floor.
const toEmail = (u) => `${u}@moneytracker.local`;
const toPass = (p) => (p.length >= 6 ? p : p + "0#mtPad".slice(0, 6 - p.length));

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("auth-user").value.trim().toLowerCase();
  const pass = toPass($("auth-pass").value);
  const btn = $("auth-submit");
  btn.disabled = true;
  $("auth-error").classList.add("hidden");
  try {
    if (!/^[a-z0-9._-]{2,20}$/.test(username)) {
      throw new Error("Username: 2–20 letters, numbers, dots, dashes or underscores.");
    }
    const email = toEmail(username);
    if (signupMode) {
      const name = $("auth-name").value.trim() || username;
      const { error } = await supa.auth.signUp({ email, password: pass, options: { data: { display_name: name } } });
      if (error) throw new Error(/already/i.test(error.message) ? "That username is taken." : error.message);
      const { error: e2 } = await supa.auth.signInWithPassword({ email, password: pass });
      if (e2) throw new Error("Account created but sign-in failed — make sure 'Confirm email' is OFF in Supabase auth settings.");
    } else {
      const { error } = await supa.auth.signInWithPassword({ email, password: pass });
      if (error) throw new Error("Wrong username or password.");
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

const VIEW_TITLES = { home: "Home", breakdown: "Breakdown", add: "Add", stats: "Stats", chat: "Chat", settings: "Settings" };
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
$("card-trend").addEventListener("click", () => switchView("stats"));
$("card-trend").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") switchView("stats"); });

function renderCurrent() {
  if (view === "home") renderHome();
  if (view === "breakdown") renderBreakdown();
  if (view === "stats") renderStats();
  if (view === "add") renderAddIdle();
  if (view === "chat") renderChat();
  if (view === "settings") renderSettings();
}

/* ================= HOME ================= */
function renderHome() {
  const all = visibleTxs();
  const list = all.filter(isExpense);
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

  const paceEl = $("hero-pace");
  paceEl.textContent = total > 0 ? `${fmtRM(total / new Date().getDate())}/day average` : "";

  renderDonutCard();
  renderTrend(list);
  renderBudgets();
  renderRecurring(list);
  renderTopMerchants(monthTxs);
  renderMonthReceipt(monthTxs, total);
}

function monthDateAt(off) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + off);
  return d;
}

function renderDonutCard() {
  const list = visibleTxs().filter(isExpense);
  const d = monthDateAt(homeOffset);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const cur = list.filter((t) => monthKeyOf(t.tx_date) === key);
  const total = cur.reduce((s, t) => s + Number(t.total), 0);
  $("donut-month").textContent = MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? " '" + String(d.getFullYear()).slice(2) : "");
  $("donut-next").disabled = homeOffset >= 0;
  renderDonut(cur, total, homeOffset === 0 ? "this month" : MONTHS[d.getMonth()]);
}

$("donut-prev").addEventListener("click", () => { homeOffset--; renderDonutCard(); });
$("donut-next").addEventListener("click", () => { if (homeOffset < 0) { homeOffset++; renderDonutCard(); } });

function renderDonut(monthTxs, total, centerText) {
  const holder = $("donut-holder"), legend = $("donut-legend");
  const byCat = CATEGORIES.map((c) => ({
    ...c,
    sum: monthTxs.filter((t) => t.category === c.name).reduce((s, t) => s + Number(t.total), 0),
  })).filter((c) => c.sum > 0).sort((a, b) => b.sum - a.sum);

  if (!byCat.length) {
    holder.innerHTML = "";
    legend.innerHTML = `<li class="empty-note" style="padding:12px 0">Nothing spent in this month.</li>`;
    return;
  }

  const R = 44, SW = 18, C = 2 * Math.PI * R, GAP = 2.5;
  let offset = 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("width", "128"); svg.setAttribute("height", "128");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Spending by category");
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
  label.textContent = centerText;
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
    if (m.sum > 0) {
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
  const myMonth = txs.filter((t) => isExpense(t) && t.user_id === session.user.id && monthKeyOf(t.tx_date) === thisMonthKey());
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

function renderRecurring(list) {
  const card = $("card-recurring");
  const byMerchant = {};
  list.forEach((t) => {
    const k = t.merchant.toLowerCase().trim();
    (byMerchant[k] = byMerchant[k] || []).push(t);
  });
  const found = [];
  for (const k in byMerchant) {
    const months = {};
    byMerchant[k].forEach((t) => {
      const m = monthKeyOf(t.tx_date);
      months[m] = (months[m] || 0) + Number(t.total);
    });
    const keys = Object.keys(months);
    if (keys.length < 3) continue;
    const vals = keys.map((m) => months[m]);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (avg <= 0) continue;
    if (vals.every((v) => Math.abs(v - avg) / avg < 0.25)) {
      found.push({ name: byMerchant[k][0].merchant, category: byMerchant[k][0].category, avg, n: keys.length });
    }
  }
  if (!found.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  found.sort((a, b) => b.avg - a.avg);
  $("recurring-list").innerHTML = found.slice(0, 5).map((r) => `
    <div class="rec-row">
      <span class="cat-badge small" style="--cc:var(${catVar(r.category)})">${catOf(r.category).e}</span>
      <span class="rec-mid"><span class="rec-name">${esc(r.name)}</span><br>
      <span class="rec-sub">${r.n} months running</span></span>
      <span class="rec-amt mono">${fmtRM(r.avg)}<small>/month</small></span>
    </div>`).join("");
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
  const names = ["All", ...CATEGORIES.map((c) => c.name), "Income"];
  chips.innerHTML = names.map((n) => {
    const c = n === "All" || n === "Income" ? null : catOf(n);
    const style = c ? `style="--cc:var(${c.v})"` : n === "Income" ? `style="--cc:var(--cat-6)"` : "";
    const icon = c ? c.e : n === "Income" ? "💰" : "✨";
    return `<button class="chip ${n === "All" ? "chip-all" : ""} ${bdCat === n ? "active" : ""}"
      ${style} data-cat="${esc(n)}">${icon} ${esc(n)}</button>`;
  }).join("");
  chips.querySelectorAll(".chip").forEach((c) =>
    c.addEventListener("click", () => { bdCat = c.dataset.cat; renderBreakdown(); })
  );
  renderBdList();
}

function renderBdList() {
  let list = visibleTxs();
  if (bdCat === "Income") {
    list = list.filter((t) => !isExpense(t));
  } else {
    list = list.filter(isExpense);
    if (bdCat !== "All") list = list.filter((t) => t.category === bdCat);
  }
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
      <span class="cat-badge" style="--cc:var(${dispCat(t).v})">${dispCat(t).e}</span>
      <span class="tx-mid">
        <span class="tx-merchant">${esc(t.merchant)}</span><br>
        <span class="tx-sub">${fmtDate(t.tx_date)} · ${esc(t.category)}${origNote(t)}${scope === "ours" && members.length > 1 ? " · " + esc(memberName(t.user_id)) : ""}</span>
      </span>
      <span class="tx-amt mono${isExpense(t) ? "" : " inc"}">${isExpense(t) ? "" : "+"}${fmtRM(t.total)}</span>
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
    <div class="modal-title"><span>${dispCat(tx).e}</span>${esc(tx.merchant)}</div>
    <div class="modal-sub">${fmtDate(tx.tx_date)} · ${esc(tx.source)}${origNote(tx)} · added by ${esc(memberName(tx.user_id))}</div>
    ${own ? `
    <div class="review-grid">
      <div class="span2"><label>Place</label><input type="text" id="m-merchant" value="${esc(tx.merchant)}"></div>
      <div class="span2 duo"><div class="duo-date"><label>Date</label><input type="date" id="m-date" value="${esc(tx.tx_date || "")}"></div>
      <div class="duo-total"><label>Total (RM)</label><input type="number" step="0.01" min="0" id="m-total" value="${Number(tx.total)}"></div></div>
      <div><label>Category</label><select id="m-cat">${(isExpense(tx) ? CATEGORIES : INCOME_CATS).map((c) => `<option value="${c.name}" ${c.name === tx.category ? "selected" : ""}>${c.e} ${c.name}</option>`).join("")}</select></div>
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
$("file-gallery").addEventListener("change", (e) => handleFiles([...e.target.files]));
$("add-manual").addEventListener("click", () => {
  reviewDrafts = [blankDraft()];
  showReview("Type it in");
});

const blankDraft = () => ({
  kind: "expense", tx_date: todayISO(), merchant: "", total: "", currency: "MYR", subtotal: null,
  category: "Other", payment_method: "Card", source: "manual", items: [], notes: "",
});

const PDFJS = "https://esm.sh/pdfjs-dist@4.10.38/build/pdf.min.mjs";
let pdfjsLib = null;
async function getPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS);
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://esm.sh/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  }
  return pdfjsLib;
}

const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

// Asks for a PDF password inside the processing pane; resolves null if skipped.
function askPdfPassword(fileName, wrongBefore) {
  return new Promise((resolve) => {
    const box = $("pdf-pass"), input = $("pdf-pass-input");
    $("pdf-pass-title").textContent = wrongBefore
      ? `Wrong password \u2014 try again for ${fileName}`
      : `${fileName} needs a password`;
    input.value = "";
    box.classList.remove("hidden");
    input.focus();
    const done = (val) => {
      box.classList.add("hidden");
      $("pdf-pass-go").removeEventListener("click", onGo);
      $("pdf-pass-skip").removeEventListener("click", onSkip);
      input.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onGo = () => done(input.value || null);
    const onSkip = () => done(null);
    const onKey = (e) => { if (e.key === "Enter") onGo(); };
    $("pdf-pass-go").addEventListener("click", onGo);
    $("pdf-pass-skip").addEventListener("click", onSkip);
    input.addEventListener("keydown", onKey);
  });
}

// Renders each PDF page to a JPEG data URL the vision model can read.
async function pdfToImages(file, onProgress) {
  const pdfjs = await getPdfjs();
  let password, doc, tries = 0;
  while (!doc) {
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      doc = await pdfjs.getDocument(password ? { data, password } : { data }).promise;
    } catch (err) {
      if (err?.name !== "PasswordException" || tries >= 3) throw err;
      password = await askPdfPassword(file.name, tries > 0);
      tries++;
      if (!password) return [];
    }
  }
  const pages = Math.min(doc.numPages, 25);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    if (onProgress) onProgress(i, pages);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1700 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    out.push(canvas.toDataURL("image/jpeg", 0.85));
  }
  return out;
}

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
  $("pdf-pass").classList.add("hidden");
  const setText = (t) => { $("add-processing-text").textContent = t; };
  setText(files.length > 1 ? `Preparing ${files.length} files\u2026` : "Reading your receipt\u2026");

  try {
    let images = [];
    for (const f of files) {
      if (isPdf(f)) {
        setText(`Opening ${f.name}\u2026`);
        try {
          images.push(...await pdfToImages(f, (p, n) => setText(`Reading page ${p} of ${n} in ${f.name}\u2026`)));
        } catch (err) {
          console.error(err);
          toast(`Couldn't open ${f.name}`);
        }
      } else {
        images.push(await downscale(f));
      }
    }
    if (!images.length) { renderAddIdle(); return; }
    if (images.length > 30) {
      toast("Reading the first 30 pages only");
      images = images.slice(0, 30);
    }

    const found = [];
    let failed = 0;
    for (let i = 0; i < images.length; i += 6) {
      const batch = images.slice(i, i + 6);
      setText(images.length > 1
        ? `Reading ${i + 1}\u2013${Math.min(i + batch.length, images.length)} of ${images.length}\u2026`
        : "Reading your receipt\u2026");
      try {
        const { data, error } = await supa.functions.invoke("extract", { body: { images: batch } });
        if (error) throw error;
        found.push(...(data.transactions || []));
      } catch {
        failed += batch.length;
      }
    }

    const drafts = found.map((t) => ({
      kind: "expense",
      currency: t.currency && RATES[t.currency] != null ? t.currency : "MYR",
      subtotal: typeof t.subtotal === "number" ? t.subtotal : null,
      tx_date: t.tx_date || todayISO(),
      merchant: t.merchant || "",
      total: t.total ?? "",
      category: CATEGORIES.some((c) => c.name === t.category) ? t.category : "Other",
      payment_method: t.payment_method || "",
      source: t.source || "receipt",
      items: t.items || [],
      notes: t.notes || "",
    }));
    if (failed) toast(`${failed} page${failed > 1 ? "s" : ""} couldn't be read \u2014 try those again`);
    if (!drafts.length) {
      if (!failed) toast("Couldn't find any spending in there \u2014 you can type it in instead");
      reviewDrafts = [blankDraft()];
    } else {
      reviewDrafts = drafts;
    }
    showReview(drafts.length > 1 ? `Found ${drafts.length} transactions` : "Check & save");
  } catch (err) {
    toast(err.message || "Something went wrong \u2014 try again or type it in");
    renderAddIdle();
  }
}

function itemsOff(d) {
  if (!d.items?.length || typeof d.subtotal !== "number" || !(d.subtotal > 0)) return false;
  const sum = d.items.reduce((a, it) => a + Number(it.price || 0), 0);
  return Math.abs(sum - d.subtotal) > 0.05;
}

function isDupe(d) {
  return txs.some((t) =>
    t.user_id === session.user.id &&
    t.merchant.toLowerCase() === String(d.merchant).toLowerCase() &&
    Number(t.total).toFixed(2) === Number(d.total).toFixed(2) &&
    t.tx_date === d.tx_date
  );
}

function updateItemsSum(card, d) {
  const el = card.querySelector('[data-role="sum"]');
  if (!el) return;
  if (!d.items.length) { el.textContent = ""; el.className = "items-sum"; return; }
  const sum = d.items.reduce((a, it) => a + Number(it.price || 0), 0);
  const off = typeof d.subtotal === "number" && d.subtotal > 0 && Math.abs(sum - d.subtotal) > 0.05;
  el.textContent = off
    ? `items ${fmtRM(sum)} ≠ receipt ${fmtRM(d.subtotal)}`
    : `items ${fmtRM(sum)}`;
  el.className = off ? "items-sum sum-bad" : "items-sum";
  const flag = card.querySelector(".sum-flag");
  if (flag) {
    flag.classList.toggle("hidden", !off);
    if (off) {
      flag.textContent = `Item prices add up to ${fmtRM(sum)}, but the receipt says ${fmtRM(d.subtotal)} — tap a line to fix. The total below is still correct.`;
    }
  }
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
      <div class="dupe-flag sum-flag ${itemsOff(d) ? "" : "hidden"}"></div>
      <div class="review-grid">
        <div class="span2 kind-toggle">
          <button type="button" class="${d.kind !== "income" ? "active" : ""}" data-kind="expense" data-i="${i}">💸 Spending</button>
          <button type="button" class="${d.kind === "income" ? "active" : ""}" data-kind="income" data-i="${i}">💰 Income</button>
        </div>
        <div class="span2"><label>${d.kind === "income" ? "From" : "Place"}</label><input type="text" data-f="merchant" value="${esc(d.merchant)}" placeholder="${d.kind === "income" ? "Who paid you?" : "Where was this?"}"></div>
        <div class="span2 duo"><div class="duo-date"><label>Date</label><input type="date" data-f="tx_date" value="${esc(d.tx_date)}"></div>
          <div class="duo-total"><label>Total (${d.currency === "MYR" ? "RM" : esc(d.currency)})</label>
          <input type="number" step="0.01" min="0" inputmode="decimal" data-f="total" value="${d.total}" placeholder="0.00">
          ${d.currency !== "MYR" ? `<span class="fx-hint">≈ ${fmtRM(Number(d.total || 0) * (RATES[d.currency] || 1))} saved in RM</span>` : ""}
        </div></div>
        <div><label>Currency</label><select data-f="currency">${CURRENCIES.map((cc) => `<option ${cc === d.currency ? "selected" : ""}>${cc}</option>`).join("")}</select></div>
        <div><label>Category</label><select data-f="category">${(d.kind === "income" ? INCOME_CATS : CATEGORIES).map((c) => `<option value="${c.name}" ${c.name === d.category ? "selected" : ""}>${c.e} ${c.name}</option>`).join("")}</select></div>
        <div><label>${d.kind === "income" ? "Received via" : "Paid with"}</label><input type="text" data-f="payment_method" value="${esc(d.payment_method)}" placeholder="Cash, card…"></div>
        <div class="span2"><label>Notes</label><input type="text" data-f="notes" value="${esc(d.notes)}"></div>
      </div>
      <div class="review-items">
        ${d._editItems ? `${d.items.map((it, j) => `
        <div class="item-edit-row" data-j="${j}">
          <input type="number" class="ie-qty" min="0" step="1" inputmode="numeric" value="${Number(it.qty) || 1}" data-if="qty" aria-label="Quantity">
          <input type="text" class="ie-name" value="${esc(it.name)}" placeholder="Item" data-if="name">
          <input type="number" class="ie-price" step="0.01" min="0" inputmode="decimal" value="${it.price}" data-if="price" aria-label="Price in RM">
          <button type="button" class="ie-del" aria-label="Remove item">×</button>
        </div>`).join("")}
        <div class="items-foot">
          <span><button type="button" class="btn-link small ie-add">+ item</button>
          <button type="button" class="btn-link small ie-done">Done</button></span>
          <span class="items-sum" data-role="sum"></span>
        </div>` : `${d.items.map((it, j) => `
        <button type="button" class="r-line item-tap" data-j="${j}">
          <span>${Number(it.qty) || 1}× ${esc(it.name)}</span><span>${fmtRM(it.price)}</span>
        </button>`).join("")}
        <div class="items-foot">
          <button type="button" class="btn-link small ie-add">${d.items.length ? "+ item" : "+ line items"}</button>
          <span class="items-sum" data-role="sum"></span>
        </div>`}
      </div>
      ${reviewDrafts.length > 1 ? `<button class="btn-danger-link review-remove" data-i="${i}">Don't save this one</button>` : ""}
    </div>`).join("");

  holder.querySelectorAll("[data-f]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const card = inp.closest(".review-card");
      const d = reviewDrafts[Number(card.dataset.i)];
      d[inp.dataset.f] = inp.value;
      if (inp.dataset.f === "total" && d.currency !== "MYR") {
        const hint = card.querySelector(".fx-hint");
        if (hint) hint.textContent = `≈ ${fmtRM(Number(d.total || 0) * (RATES[d.currency] || 1))} saved in RM`;
      }
      if (inp.dataset.f === "currency") showReview($("review-heading").textContent);
    });
  });
  holder.querySelectorAll("[data-kind]").forEach((b) =>
    b.addEventListener("click", () => {
      const d = reviewDrafts[Number(b.dataset.i)];
      if (d.kind === b.dataset.kind) return;
      d.kind = b.dataset.kind;
      d.category = d.kind === "income" ? "Salary" : "Other";
      showReview($("review-heading").textContent);
    })
  );
  holder.querySelectorAll(".item-edit-row [data-if]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const card = inp.closest(".review-card");
      const d = reviewDrafts[Number(card.dataset.i)];
      const it = d.items[Number(inp.closest(".item-edit-row").dataset.j)];
      it[inp.dataset.if] = inp.dataset.if === "name" ? inp.value : Number(inp.value);
      updateItemsSum(card, d);
    });
  });
  holder.querySelectorAll(".ie-del").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".review-card");
      reviewDrafts[Number(card.dataset.i)].items.splice(Number(b.closest(".item-edit-row").dataset.j), 1);
      showReview($("review-heading").textContent);
    })
  );
  holder.querySelectorAll(".ie-add").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".review-card");
      const d = reviewDrafts[Number(card.dataset.i)];
      d._editItems = true;
      d.items.push({ name: "", qty: 1, price: 0 });
      d._focus = { j: d.items.length - 1, f: "name" };
      showReview($("review-heading").textContent);
    })
  );
  holder.querySelectorAll(".item-tap").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".review-card");
      const d = reviewDrafts[Number(card.dataset.i)];
      d._editItems = true;
      d._focus = { j: Number(b.dataset.j), f: "price" };
      showReview($("review-heading").textContent);
    })
  );
  holder.querySelectorAll(".ie-done").forEach((b) =>
    b.addEventListener("click", () => {
      const card = b.closest(".review-card");
      const d = reviewDrafts[Number(card.dataset.i)];
      d._editItems = false;
      d.items = d.items.filter((it) => String(it.name).trim() || Number(it.price) > 0);
      showReview($("review-heading").textContent);
    })
  );
  holder.querySelectorAll(".review-card").forEach((card) => {
    const d = reviewDrafts[Number(card.dataset.i)];
    if (d._editItems && d._focus) {
      const inp = card.querySelector(`.item-edit-row[data-j="${d._focus.j}"] [data-if="${d._focus.f}"]`);
      if (inp) { inp.focus(); if (inp.select) inp.select(); }
      delete d._focus;
    }
  });
  holder.querySelectorAll(".review-card").forEach((card) =>
    updateItemsSum(card, reviewDrafts[Number(card.dataset.i)])
  );
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
    const rate = RATES[d.currency] ?? 1;
    const myr = d.currency === "MYR" ? total : total * rate;
    rows.push({
      user_id: session.user.id,
      kind: d.kind || "expense",
      tx_date: d.tx_date || todayISO(),
      merchant: String(d.merchant).trim(),
      total: myr.toFixed(2),
      currency: d.currency || "MYR",
      orig_amount: d.currency === "MYR" ? null : total.toFixed(2),
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
  $("set-email").textContent = "Signed in as @" + session.user.email.replace("@moneytracker.local", "");
  renderHouseholdCard();
  renderBudgetEditor();
  const mine = txs.filter((t) => t.user_id === session.user.id);
  const first = mine.length ? mine.reduce((a, b) => (a.tx_date < b.tx_date ? a : b)).tx_date : null;
  $("rates-line").textContent = ratesInfo.live
    ? `Exchange rates: live \u00B7 updated ${ratesInfo.date}`
    : "Exchange rates: built-in estimates (couldn't reach the rate service)";
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

/* ================= STATS ================= */
const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

function periodInfo(g, a) {
  const A = new Date(a); A.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let start, end, prev, next, label;
  if (g === "day") {
    start = A; end = A;
    prev = addDays(A, -1); next = addDays(A, 1);
    label = +A === +today ? "Today" : +A === +addDays(today, -1) ? "Yesterday"
      : `${A.getDate()} ${MONTHS[A.getMonth()]} ${A.getFullYear()}`;
  } else if (g === "week") {
    start = startOfWeek(A); end = addDays(start, 6);
    prev = addDays(start, -7); next = addDays(start, 7);
    label = `${start.getDate()} ${MONTHS[start.getMonth()]} \u2013 ${end.getDate()} ${MONTHS[end.getMonth()]}`;
  } else if (g === "month") {
    start = new Date(A.getFullYear(), A.getMonth(), 1);
    end = new Date(A.getFullYear(), A.getMonth() + 1, 0);
    prev = new Date(A.getFullYear(), A.getMonth() - 1, 1);
    next = new Date(A.getFullYear(), A.getMonth() + 1, 1);
    label = `${MONTHS_FULL[start.getMonth()]} ${start.getFullYear()}`;
  } else {
    start = new Date(A.getFullYear(), 0, 1); end = new Date(A.getFullYear(), 11, 31);
    prev = new Date(A.getFullYear() - 1, 0, 1); next = new Date(A.getFullYear() + 1, 0, 1);
    label = String(A.getFullYear());
  }
  return { start, end, prev, next, label, isCurrent: today >= start && today <= end };
}

document.querySelectorAll("#stats-gran button").forEach((b) =>
  b.addEventListener("click", () => {
    statsGran = b.dataset.g;
    document.querySelectorAll("#stats-gran button").forEach((x) => x.classList.toggle("active", x === b));
    renderStats();
  })
);
$("pn-prev").addEventListener("click", () => { statsAnchor = periodInfo(statsGran, statsAnchor).prev; renderStats(); });
$("pn-next").addEventListener("click", () => {
  const info = periodInfo(statsGran, statsAnchor);
  if (!info.isCurrent) { statsAnchor = info.next; renderStats(); }
});

function renderStats() {
  const info = periodInfo(statsGran, statsAnchor);
  $("pn-label").textContent = info.label;
  $("pn-next").disabled = info.isCurrent;
  const allTx = visibleTxs();
  const inRange = (t, s, e) => t.tx_date >= toISO(s) && t.tx_date <= toISO(e);
  const curAll = allTx.filter((t) => inRange(t, info.start, info.end));
  const cur = curAll.filter(isExpense);
  const curInc = curAll.filter((t) => !isExpense(t));
  const pinfo = periodInfo(statsGran, info.prev);
  const prevTx = allTx.filter(isExpense).filter((t) => inRange(t, pinfo.start, pinfo.end));
  const total = cur.reduce((s, t) => s + Number(t.total), 0);
  const prevTotal = prevTx.reduce((s, t) => s + Number(t.total), 0);

  // tiles
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const lastDay = today < info.end ? today : info.end;
  const daysSoFar = Math.max(1, Math.round((lastDay - info.start) / 86400000) + 1);
  let deltaSub = "no data for the period before";
  let deltaCls = "";
  if (prevTotal > 0) {
    const dp = Math.round(((total - prevTotal) / prevTotal) * 100);
    deltaSub = `${dp >= 0 ? "\u2191" : "\u2193"} ${Math.abs(dp)}% vs previous`;
    deltaCls = dp < 0 ? "down" : "";
  }
  const biggest = cur.length ? cur.reduce((a, b) => (Number(b.total) > Number(a.total) ? b : a)) : null;
  const byCatMap = {};
  cur.forEach((t) => { byCatMap[t.category] = (byCatMap[t.category] || 0) + Number(t.total); });
  const topCat = Object.entries(byCatMap).sort((a, b) => b[1] - a[1])[0];
  const thirdTile = statsGran === "day"
    ? `<div class="stat-tile"><div class="st-label">Biggest</div><div class="st-value">${biggest ? esc(biggest.merchant) : "\u2014"}</div><div class="st-sub">${biggest ? fmtRM(biggest.total) : ""}</div></div>`
    : `<div class="stat-tile"><div class="st-label">Average / day</div><div class="st-value mono">${fmtRM(total / daysSoFar)}</div><div class="st-sub">over ${daysSoFar} day${daysSoFar > 1 ? "s" : ""}</div></div>`;
  $("stat-tiles").innerHTML = `
    <div class="stat-tile"><div class="st-label">Total spent</div><div class="st-value mono">${fmtRM(total)}</div>
      <div class="st-sub ${deltaCls}">${deltaSub}</div></div>
    <div class="stat-tile"><div class="st-label">Entries</div><div class="st-value">${cur.length}</div>
      <div class="st-sub">${new Set(cur.map((t) => t.tx_date)).size} day${new Set(cur.map((t) => t.tx_date)).size === 1 ? "" : "s"} with spending</div></div>
    ${thirdTile}
    <div class="stat-tile"><div class="st-label">Top category</div><div class="st-value">${topCat ? catOf(topCat[0]).e + " " + esc(topCat[0]) : "\u2014"}</div>
      <div class="st-sub">${topCat ? fmtRM(topCat[1]) : ""}</div></div>${(() => {
        const incTotal = curInc.reduce((s, t) => s + Number(t.total), 0);
        if (incTotal <= 0) return "";
        const net = incTotal - total;
        return `
    <div class="stat-tile"><div class="st-label">Income</div><div class="st-value mono">${fmtRM(incTotal)}</div>
      <div class="st-sub">${curInc.length} entr${curInc.length === 1 ? "y" : "ies"}</div></div>
    <div class="stat-tile"><div class="st-label">Net</div><div class="st-value mono">${net >= 0 ? "+" : "−"}${fmtRM(Math.abs(net))}</div>
      <div class="st-sub ${net >= 0 ? "down" : ""}">income minus spending</div></div>`;
      })()}`;

  renderStatsChart(cur, info);
  renderHeat(cur, info);
  renderStatsCats(byCatMap, total);
  renderStatsList(curAll);
}

function renderStatsChart(cur, info) {
  const card = $("stats-chart-card"), holder = $("stats-chart");
  if (statsGran === "day") { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const buckets = [];
  if (statsGran === "week") {
    const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    for (let i = 0; i < 7; i++) buckets.push({ key: toISO(addDays(info.start, i)), label: names[i], show: true, sum: 0 });
    cur.forEach((t) => { const b = buckets.find((x) => x.key === t.tx_date); if (b) b.sum += Number(t.total); });
    $("stats-chart-title").textContent = "Per day";
  } else if (statsGran === "month") {
    const n = info.end.getDate();
    for (let i = 1; i <= n; i++) buckets.push({ key: i, label: String(i), show: i === 1 || i % 5 === 0, sum: 0 });
    cur.forEach((t) => { buckets[Number(t.tx_date.slice(8, 10)) - 1].sum += Number(t.total); });
    $("stats-chart-title").textContent = "Per day";
  } else {
    for (let i = 0; i < 12; i++) buckets.push({ key: i, label: MONTHS[i][0], show: true, sum: 0 });
    cur.forEach((t) => { buckets[Number(t.tx_date.slice(5, 7)) - 1].sum += Number(t.total); });
    $("stats-chart-title").textContent = "Per month";
  }
  const max = Math.max(...buckets.map((b) => b.sum), 1);
  const W = 340, H = 150, PAD = 10, baseY = H - 24, topY = 22;
  const n = buckets.length;
  const slot = (W - PAD * 2) / n;
  const bw = Math.min(30, slot * 0.68);
  let out = "";
  const vfont = n > 14 ? 7.5 : n > 8 ? 9 : 11;
  buckets.forEach((b, i) => {
    const x = PAD + i * slot + (slot - bw) / 2;
    const h = Math.max((b.sum / max) * (baseY - topY), b.sum > 0 ? 2.5 : 0);
    const y = baseY - h;
    if (b.sum > 0) {
      const r = Math.min(3, h, bw / 2);
      out += `<path class="trend-bar" data-i="${i}" d="M${x},${baseY} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + bw - r},${y} Q${x + bw},${y} ${x + bw},${y + r} L${x + bw},${baseY} Z" style="fill:var(--trend)"/>`;
    }
    if (b.sum > 0) {
      const vLabel = b.sum >= 10000 ? (b.sum / 1000).toFixed(1) + "k" : b.sum >= 1000 ? (b.sum / 1000).toFixed(1) + "k" : Math.round(b.sum);
      out += `<text class="bar-value" style="font-size:${vfont}px" x="${Math.min(Math.max(x + bw / 2, 10), W - 10)}" y="${y - 4}" text-anchor="middle">${vLabel}</text>`;
    }
    if (b.show) out += `<text class="axis-label" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${b.label}</text>`;
  });
  holder.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Spending over the period">
    <line class="gridline" x1="${PAD}" y1="${baseY}" x2="${W - PAD}" y2="${baseY}"/>${out}</svg>`;
  holder.querySelectorAll(".trend-bar").forEach((el) => {
    const b = buckets[Number(el.dataset.i)];
    bindTip(el, `${statsGran === "year" ? MONTHS[Number(el.dataset.i)] : b.label} \u00B7 ${fmtRM(b.sum)}`);
  });
}

function renderHeat(cur, info) {
  const card = $("stats-heat-card");
  if (statsGran !== "month") { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  $("heat-week").innerHTML = ["M", "T", "W", "T", "F", "S", "S"].map((d) => `<span>${d}</span>`).join("");
  const days = info.end.getDate();
  const sums = Array(days + 1).fill(0);
  cur.forEach((t) => { sums[Number(t.tx_date.slice(8, 10))] += Number(t.total); });
  const max = Math.max(...sums, 1);
  const lead = (info.start.getDay() + 6) % 7;
  const today = new Date();
  const isThisMonth = today.getFullYear() === info.start.getFullYear() && today.getMonth() === info.start.getMonth();
  let html = "";
  for (let i = 0; i < lead; i++) html += "<span></span>";
  for (let d = 1; d <= days; d++) {
    const r = sums[d] / max;
    const pct = sums[d] > 0 ? Math.round(15 + 65 * r) : 0;
    const cls = `heat-cell ${sums[d] > 0 ? "has" : ""} ${r > 0.55 ? "hot" : ""} ${isThisMonth && d === today.getDate() ? "today" : ""}`;
    html += `<button class="${cls}" data-d="${d}" ${pct ? `style="background:color-mix(in srgb, var(--trend) ${pct}%, var(--card))"` : "disabled"}>${d}</button>`;
  }
  $("heat-grid").innerHTML = html;
  $("heat-grid").querySelectorAll(".heat-cell.has").forEach((cell) => {
    const d = Number(cell.dataset.d);
    bindTip(cell, `${d} ${MONTHS[info.start.getMonth()]} \u00B7 ${fmtRM(sums[d])}`);
    cell.addEventListener("click", () => {
      statsGran = "day";
      statsAnchor = new Date(info.start.getFullYear(), info.start.getMonth(), d);
      document.querySelectorAll("#stats-gran button").forEach((x) => x.classList.toggle("active", x.dataset.g === "day"));
      renderStats();
    });
  });
}

function renderStatsCats(byCatMap, total) {
  const holder = $("stats-cats");
  const rows = Object.entries(byCatMap).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    holder.innerHTML = `<p class="muted">Nothing in this period.</p>`;
    return;
  }
  holder.innerHTML = rows.map(([name, sum]) => {
    const c = catOf(name);
    return `<div class="cat-mini">
      <span class="cat-mini-emoji">${c.e}</span>
      <div class="cat-mini-mid">
        <div class="cat-mini-head"><span>${esc(name)}</span><span class="mono">${fmtRM(sum)} \u00B7 ${Math.round((sum / total) * 100)}%</span></div>
        <div class="cat-mini-track"><div class="cat-mini-fill" style="--p:${sum / total};background:var(${c.v})"></div></div>
      </div></div>`;
  }).join("");
}

function renderStatsList(cur) {
  const holder = $("stats-list");
  const heading = $("stats-list-heading");
  if (!cur.length) {
    heading.textContent = "";
    holder.innerHTML = `<p class="empty-note"><span class="big">🍃</span>No spending in this period.</p>`;
    return;
  }
  const list = [...cur].sort((a, b) => (b.tx_date || "").localeCompare(a.tx_date || ""));
  const shown = list.slice(0, 60);
  heading.textContent = `Entries (${list.length})`;
  holder.innerHTML = shown.map((t) => `
    <button class="tx-row" data-id="${t.id}">
      <span class="cat-badge" style="--cc:var(${dispCat(t).v})">${dispCat(t).e}</span>
      <span class="tx-mid">
        <span class="tx-merchant">${esc(t.merchant)}</span><br>
        <span class="tx-sub">${fmtDate(t.tx_date)} \u00B7 ${esc(t.category)}${origNote(t)}${scope === "ours" && members.length > 1 ? " \u00B7 " + esc(memberName(t.user_id)) : ""}</span>
      </span>
      <span class="tx-amt mono${isExpense(t) ? "" : " inc"}">${isExpense(t) ? "" : "+"}${fmtRM(t.total)}</span>
    </button>`).join("") + (list.length > shown.length ? `<p class="muted" style="text-align:center">Showing ${shown.length} of ${list.length}</p>` : "");
  holder.querySelectorAll(".tx-row").forEach((r) =>
    r.addEventListener("click", () => openTxModal(txs.find((t) => t.id === r.dataset.id)))
  );
}

/* ---------- CSV export ---------- */
$("export-csv").addEventListener("click", () => {
  const list = visibleTxs();
  if (!list.length) return toast("Nothing to export yet");
  const head = "date,kind,merchant,total_rm,currency,orig_amount,category,payment_method,source,person,notes\n";
  const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const body = list.map((t) =>
    [t.tx_date, t.kind || "expense", csvEsc(t.merchant), Number(t.total).toFixed(2), t.currency || "MYR",
     t.orig_amount ?? "", csvEsc(t.category), csvEsc(t.payment_method || ""), t.source,
     csvEsc(memberName(t.user_id)), csvEsc(t.notes || "")].join(",")
  ).join("\n");
  const blob = new Blob([head + body], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `money-tracker-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ---------- boot ---------- */
loadRates();

(async () => {
  const { data } = await supa.auth.getSession();
  if (!data.session) $("screen-auth").classList.remove("hidden");
  // onAuthStateChange handles the rest
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* offline shell is a nicety, not a need */ });
}
