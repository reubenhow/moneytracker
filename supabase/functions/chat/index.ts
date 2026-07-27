// Money Tracker — "chat" Edge Function
// Answers natural-language questions about the caller's spending.
// Fetches the user's visible transactions (own + household, enforced by RLS),
// compacts them into context, and asks OpenAI.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  let message = "", history: { role: string; content: string }[] = [], scope = "mine";
  try {
    const body = await req.json();
    message = String(body.message ?? "").slice(0, 2000);
    history = Array.isArray(body.history) ? body.history.slice(-8) : [];
    scope = body.scope === "ours" ? "ours" : "mine";
  } catch {
    return json({ error: "Bad request body" }, 400);
  }
  if (!message.trim()) return json({ error: "Empty message" }, 400);

  // Member names, so "ours" answers can say who spent what.
  const { data: profiles } = await supa.from("profiles").select("id, display_name");
  const names = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  let q = supa
    .from("transactions")
    .select("user_id, tx_date, merchant, total, kind, category, payment_method, notes, items")
    .order("tx_date", { ascending: false })
    .limit(4000);
  if (scope === "mine") q = q.eq("user_id", user.id);
  const { data: txs, error } = await q;
  if (error) return json({ error: "Could not load your transactions" }, 500);

  const lines = (txs ?? []).map((t) => {
    const items = Array.isArray(t.items) && t.items.length
      ? "|bought: " + t.items.map((i: { qty?: number; name?: string; price?: number }) =>
          `${Number(i.qty) || 1}x ${i.name} (${Number(i.price || 0).toFixed(2)})`).join(", ").slice(0, 220)
      : "";
    return `${t.tx_date}|${t.merchant}|RM ${Number(t.total).toFixed(2)}|${t.category}|${names.get(t.user_id) ?? "?"}${t.kind === "income" ? "|INCOME" : ""}${t.notes ? "|" + t.notes : ""}${items}`;
  });

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY secret not set on the server" }, 500);

  // Precompute exact totals — the model must not do long arithmetic itself.
  const exp = (txs ?? []).filter((t) => t.kind !== "income");
  const monthTot = new Map<string, number>();
  const catTot = new Map<string, number>();
  const merch = new Map<string, { sum: number; n: number; last: string }>();
  for (const t of exp) {
    const m = String(t.tx_date).slice(0, 7);
    monthTot.set(m, (monthTot.get(m) || 0) + Number(t.total));
    catTot.set(t.category, (catTot.get(t.category) || 0) + Number(t.total));
    const e = merch.get(t.merchant) || { sum: 0, n: 0, last: String(t.tx_date) };
    e.sum += Number(t.total); e.n++;
    if (String(t.tx_date) > e.last) e.last = String(t.tx_date);
    merch.set(t.merchant, e);
  }
  const aggMonths = [...monthTot.entries()].sort().slice(-12)
    .map(([m, v]) => `${m}: RM ${v.toFixed(2)}`).join("; ");
  const aggCats = [...catTot.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, v]) => `${c}: RM ${v.toFixed(2)}`).join("; ");
  const aggTops = [...merch.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 15)
    .map(([k, e]) => `${k}: RM ${e.sum.toFixed(2)}, ${e.n} visit(s), last ${e.last}`).join("; ");

  const system = `You are the assistant inside "Money Tracker", a personal spending app. Currency is RM (Malaysian Ringgit).
Today's date: ${new Date().toISOString().slice(0, 10)}.
The user's ${scope === "ours" ? "household's" : "own"} transactions are below, newest first, one per line:
date|merchant|amount|category|person(|INCOME)(|notes)(|bought: line items with prices)

<transactions>
${lines.join("\n") || "(no transactions yet)"}
</transactions>

Lines ending in |INCOME are money received (salary etc.), not spending; everything else is spending. Net = income minus spending.

PRECOMPUTED EXACT TOTALS (spending only — trust these over your own arithmetic; only compute manually for questions these don't cover):
Monthly totals: ${aggMonths || "none"}
Category totals (all time): ${aggCats || "none"}
Top merchants: ${aggTops || "none"}
Answer questions using ONLY this data. Do arithmetic carefully. Format money as RM 1,234.56.
Be warm and brief — a couple of sentences, or a short list when comparing things.
If the data can't answer, say so plainly. Point out useful patterns (recurring charges, unusual spikes) when they're relevant to the question.`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        ...history.filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
        { role: "user", content: message },
      ],
      max_tokens: 1000,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    console.error("OpenAI error:", await resp.text());
    return json({ error: "The assistant is unavailable right now. Try again in a moment." }, 502);
  }

  const data = await resp.json();
  return json({ reply: data.choices?.[0]?.message?.content ?? "…" });
});
