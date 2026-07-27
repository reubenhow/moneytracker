// Money Tracker — "extract" Edge Function
// Receives receipt / bank-statement photos (base64 data URLs), sends them to
// OpenAI vision, returns structured transactions. Images are never stored.

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
- A receipt photo produces exactly ONE transaction with its line items.
- A bank or card statement page produces ONE transaction PER spending line (debits, purchases, payments out). SKIP incoming money: deposits, salary, refunds, transfers in.
- tx_date: ISO YYYY-MM-DD. If the year is missing assume the most recent plausible one. If no date is visible at all, use null.
- merchant: clean, human-readable name (e.g. "Tesco Extra Cheras", not "TESCO EXTRA CHERAS SDN BHD 003421"). For statements, clean up each line's merchant.
- total: the final amount paid, as a positive number, in the document's own currency.
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
- payment_method: e.g. "Cash", "Visa •1234", "Touch 'n Go", "DuitNow QR", or null.
- notes: anything useful that doesn't fit elsewhere (e.g. "includes 6% SST"), else null.
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
            required: ["tx_date", "merchant", "total", "currency", "category", "payment_method", "source", "items", "notes"],
          },
        },
      },
      required: ["transactions"],
    },
  },
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

  const openaiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openaiKey) return json({ error: "OPENAI_API_KEY secret not set on the server" }, 500);

  const content: unknown[] = [
    { type: "text", text: `Extract all spending from these ${images.length} image(s). Today's date is ${new Date().toISOString().slice(0, 10)}.` },
    ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: RESPONSE_SCHEMA,
      max_tokens: 8000,
      temperature: 0,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error("OpenAI error:", err);
    return json({ error: "AI extraction failed. Try again, or add the entry manually." }, 502);
  }

  const data = await resp.json();
  try {
    const parsed = JSON.parse(data.choices[0].message.content);
    return json({ transactions: parsed.transactions ?? [] });
  } catch {
    return json({ error: "AI returned an unreadable result. Try again." }, 502);
  }
});
