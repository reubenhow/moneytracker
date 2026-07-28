// Money Tracker — "extract" Edge Function
// Receives receipt / bank-statement photos (base64 data URLs), sends them to
// OpenAI vision, returns structured transactions. Images are never stored.
//
// Accuracy comes from CODE, not from the model's own self-assessment: item
// prices are summed here and compared to the printed subtotal. A mismatch
// triggers one corrective re-read, and anything still off is flagged so the
// app can warn the user instead of silently saving wrong numbers.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORIES = [
  "Food & Drinks", "Groceries", "Transport", "Shopping",
  "Bills & Utilities", "Health", "Leisure & Travel", "Other",
];

const SYSTEM_PROMPT = `You extract spending data from photos of receipts and bank/card statements, mostly from Malaysia (currency RM / MYR unless clearly stated otherwise).

Rules:
- A photo of ONE receipt produces ONE transaction with its line items.
- A photo showing SEVERAL SEPARATE receipts at once (multiple slips laid out together, different merchants/dates/totals) produces ONE transaction PER receipt. Treat each slip independently: its own merchant, date, total and items. Never merge two slips into one transaction, and never split a single long receipt into several.
- A bank or card statement page produces ONE transaction PER spending line (debits, purchases, payments out). SKIP incoming money: deposits, salary, refunds, transfers in.
- tx_date: ISO YYYY-MM-DD. If the year is missing assume the most recent plausible one. If no date is visible at all, use null.
- merchant: clean, human-readable name (e.g. "Tesco Extra Cheras", not "TESCO EXTRA CHERAS SDN BHD 003421"). For statements, clean up each line's merchant.
- total: the final amount actually paid (after service charge, tax and rounding), as a positive number, in the document's own currency.
- subtotal: the printed subtotal / "Total Sales" BEFORE service charge, tax and rounding, copied exactly as printed. Use null only when the document prints no subtotal at all (usual for statement lines).
- currency: ISO 4217 code of the money on the document (MYR for Malaysian receipts; the printed currency for foreign receipts, e.g. THB, SGD, JPY).
- category: exactly one of ${JSON.stringify(CATEGORIES)}. Pick the best fit. Judge by what the merchant IS, not just what's written:
  · Petrol stations (Petronas, Shell, Petron, BHPetrol, Caltex), tolls (Touch 'n Go, PLUS), parking, Grab/taxi rides, LRT/MRT/KTM, car wash & service = Transport.
  · Restaurants, mamak, kopitiam, cafes, fast food, food delivery (GrabFood, Foodpanda, ShopeeFood) = Food & Drinks.
  · Supermarkets & minimarts (Lotus's, Jaya Grocer, Village Grocer, AEON, Mydin, 99 Speedmart, KK Mart, wet markets) = Groceries.
  · Clinics, hospitals, pharmacies (Guardian/Watsons medicine, Caring, Alpro), dental, insurance for health = Health.
  · TNB, water bills, Unifi/Maxis/Celcom/Digi/U Mobile, Astro, phone top-ups, general insurance = Bills & Utilities.
  · Cinemas (GSC, TGV), hotels, flights (AirAsia, MAS), theme parks, sports, hobbies = Leisure & Travel.
  · Clothing, electronics, online shopping (Shopee, Lazada, TikTok Shop), home goods (Mr DIY, IKEA) = Shopping.
  · "Other" is a LAST RESORT — only when nothing above fits. ALWAYS read the line items first: if they are dishes, drinks or food (pasta, burger, latte, nasi, etc.), the category is Food & Drinks no matter what the venue is called. Groceries items (raw ingredients, household goods) mean Groceries. Medicines mean Health.
- items: line items from receipts as {name, qty, price}. Empty array for statement lines.
  price is the AMOUNT for that whole line (quantity already included — what that line contributes to the subtotal), not a unit price.
  Read the item block ONE LINE AT A TIME. Most receipts print the name and its amount on the SAME line, name left, amount right. Some print the amount on the line BELOW the name; modifier lines (Iced, Medium Well, "NO ...", special requests) belong to the item above them and never carry a price of their own. Work out which of these two layouts the receipt uses before assigning any price.
  Photos are often tilted: in a skewed photo an amount can APPEAR to sit beside a neighbouring item's name. That apparent alignment is an artifact — follow the receipt's own structure, never the photo's visual rows.
  The item amounts MUST add up to the printed subtotal. This is verified mechanically after you answer, so a wrong pairing will be caught and sent back to you.
- payment_method: how it was actually paid, read from the payment/tender line near the bottom (e.g. "Credit card", "Visa •1234", "Touch 'n Go", "DuitNow QR") — never a cashier or staff name printed in the header. Note that "Served by Cash", "Cashier: ...", or a similar header line names a person or till, NOT the payment method.
  This household pays by card. Default to "Card" when the tender line is missing, unreadable or ambiguous. Only answer "Cash" when a cash tender is explicitly printed as the payment (e.g. a "CASH 200.00" line with change given).
- notes: anything useful that doesn't fit elsewhere (e.g. "includes 10% service charge and 6% SST", "5 pax"), else null.
- If an image is unreadable or contains no spending data, contribute no transactions from it.`;

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "extracted_transactions",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        transactions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              tx_date: { type: ["string", "null"] },
              merchant: { type: "string" },
              total: { type: "number" },
              subtotal: { type: ["number", "null"] },
              currency: { type: "string" },
              category: { type: "string", enum: CATEGORIES },
              payment_method: { type: ["string", "null"] },
              source: { type: "string", enum: ["receipt", "statement"] },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    qty: { type: "number" },
                    price: { type: "number" },
                  },
                  required: ["name", "qty", "price"],
                },
              },
              notes: { type: ["string", "null"] },
            },
            required: ["tx_date", "merchant", "total", "subtotal", "currency", "category", "payment_method", "source", "items", "notes"],
          },
        },
      },
      required: ["transactions"],
    },
  },
};

type Item = { name: string; qty: number; price: number };
type Tx = {
  tx_date: string | null; merchant: string; total: number; subtotal: number | null;
  currency: string; category: string; payment_method: string | null;
  source: string; items: Item[]; notes: string | null; items_mismatch?: boolean;
};

const itemsSum = (t: Tx) => (t.items ?? []).reduce((s, i) => s + Number(i.price || 0), 0);
// Only meaningful when the receipt printed a subtotal and items were read.
const isOff = (t: Tx) =>
  typeof t.subtotal === "number" && t.subtotal > 0 && (t.items?.length ?? 0) > 0 &&
  Math.abs(itemsSum(t) - t.subtotal) > 0.05;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Provider is chosen by which secret exists: set GEMINI_API_KEY to use Gemini,
// remove it to fall back to OpenAI. No code change needed to switch.
const GEMINI_MODEL = "gemini-3.6-flash";
const JSON_SHAPE_HINT = `Return JSON of this shape: {"transactions":[{"tx_date","merchant","total","subtotal","currency","category","payment_method","source","items":[{"name","qty","price"}],"notes"}]}`;

// Warm instances remember which OpenAI model this account can actually use.
let preferredModel = "gpt-4.1";

// The conversation is held in OpenAI's message shape and translated for Gemini,
// so the verification retry below works identically on both providers.
type Msg = { role: string; content: unknown };

async function askOpenAI(messages: Msg[], key: string) {
  const candidates = preferredModel === "gpt-4.1" ? ["gpt-4.1", "gpt-4o"] : [preferredModel];
  let lastError = "";
  for (const model of candidates) {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        response_format: RESPONSE_SCHEMA,
        max_tokens: 8000,
        temperature: 0,
      }),
    });
    if (resp.ok) {
      preferredModel = model;
      const data = await resp.json();
      return JSON.parse(data.choices[0].message.content) as { transactions: Tx[] };
    }
    lastError = await resp.text();
    console.error(`model ${model} failed:`, lastError.slice(0, 400));
    if (model === "gpt-4.1") preferredModel = "gpt-4o";
  }
  throw new Error(lastError);
}

async function askGemini(messages: Msg[], key: string) {
  let system = "";
  const contents: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") { system = String(m.content); continue; }
    const parts: unknown[] = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const block of m.content as { type: string; text?: string; image_url?: { url: string } }[]) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image_url" && block.image_url) {
          const [head, data] = block.image_url.url.split(",", 2);
          const mime = head.slice(head.indexOf(":") + 1, head.indexOf(";"));
          parts.push({ inline_data: { mime_type: mime, data } });
        }
      }
    }
    // Gemini calls the assistant side "model".
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `${system}

${JSON_SHAPE_HINT}` }] },
        contents,
        generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8000 },
      }),
    },
  );
  if (!resp.ok) {
    const err = await resp.text();
    console.error("gemini failed:", err.slice(0, 400));
    throw new Error(err);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return JSON.parse(text) as { transactions: Tx[] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Require a signed-in user — the OpenAI key is not a public resource.
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  let images: string[];
  try {
    const body = await req.json();
    images = Array.isArray(body.images) ? body.images : [];
  } catch {
    return json({ error: "Bad request body" }, 400);
  }
  if (images.length === 0) return json({ error: "No images" }, 400);
  if (images.length > 6) return json({ error: "Max 6 images per upload" }, 400);
  for (const img of images) {
    if (typeof img !== "string" || !img.startsWith("data:image/")) {
      return json({ error: "Images must be data URLs" }, 400);
    }
  }

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!geminiKey && !openaiKey) {
    return json({ error: "No AI key set on the server (GEMINI_API_KEY or OPENAI_API_KEY)" }, 500);
  }
  const askAI = (msgs: Msg[]) =>
    geminiKey ? askGemini(msgs, geminiKey) : askOpenAI(msgs, openaiKey!);

  // Learn from this user's history: same merchant -> same category next time.
  let known = "";
  try {
    const { data: hist } = await supa
      .from("transactions")
      .select("merchant, category, kind")
      .order("created_at", { ascending: false })
      .limit(300);
    if (hist?.length) {
      const map = new Map<string, string>();
      for (const h of hist) {
        if (h.kind === "income") continue;
        const k = String(h.merchant).toLowerCase();
        if (!map.has(k)) map.set(k, `${h.merchant}=${h.category}`);
      }
      known = [...map.values()].slice(0, 80).join("; ");
    }
  } catch (_) { /* history is a bonus, never a blocker */ }

  const userContent: unknown[] = [
    { type: "text", text: `Extract all spending from these ${images.length} image(s). Today's date is ${new Date().toISOString().slice(0, 10)}.` },
    ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
  ];

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT + (known ? `\n\nThis user's known merchants and their chosen categories — reuse them (match loosely: ignore case, branch names, store numbers): ${known}` : "") },
    { role: "user", content: userContent },
  ];

  let result: { transactions: Tx[] };
  try {
    result = await askAI(messages);
  } catch (err) {
    console.error("OpenAI error:", err);
    return json({ error: "AI extraction failed. Try again, or add the entry manually." }, 502);
  }

  // ---- Mechanical verification: item amounts must reconstruct the subtotal ----
  let txs = result.transactions ?? [];
  const wrong = txs.filter(isOff);
  if (wrong.length) {
    const detail = wrong.map((t) =>
      `"${t.merchant}": you listed ${t.items.length} items summing to ${itemsSum(t).toFixed(2)}, but the printed subtotal is ${Number(t.subtotal).toFixed(2)} (off by ${(itemsSum(t) - Number(t.subtotal)).toFixed(2)}).`
    ).join(" ");
    try {
      const retry = await askAI([
        ...messages,
        { role: "assistant", content: JSON.stringify(result) },
        {
          role: "user",
          content: `The item amounts do not reconstruct the printed subtotal. ${detail}
Look at the image again and re-read the item block line by line. For each line, identify which printed number is that line's amount before writing it down. Common causes: taking a neighbouring line's number, skipping a line, counting a line twice, or reading a unit price where an amount is printed. Keep merchant, date, total and subtotal exactly as before — only item names, quantities and amounts may change. Return corrected JSON for ALL transactions.`,
        },
      ]);
      const retryTxs = retry.transactions ?? [];
      // Keep whichever pass reconstructs more subtotals correctly.
      if (retryTxs.length === txs.length && retryTxs.filter(isOff).length < wrong.length) {
        txs = retryTxs;
      }
    } catch (err) {
      console.error("verification pass failed:", err);
    }
  }

  for (const t of txs) t.items_mismatch = isOff(t);
  return json({ transactions: txs });
});
