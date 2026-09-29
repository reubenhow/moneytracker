// Money Tracker — "docscan" Edge Function
// Receives photos or PDF pages of ANY piece of paper (base64 data URLs) and
// writes down everything on it: a title, the label/value pairs, and a full
// transcript. Unlike "extract" this is not about money — it is a filing
// cabinet for paper, so nothing is summarised away.
//
// Provider is chosen by which secret exists: GEMINI_API_KEY -> Gemini,
// otherwise OPENAI_API_KEY -> OpenAI. Same pattern as the extract function.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DOC_TYPES = [
  "Note", "Form", "Letter", "Contract", "ID", "Medical", "Bill", "Receipt",
  "Menu", "Recipe", "List", "Schedule", "Card", "Certificate", "Other",
];

const MAX_PAGES = 12;

const SYSTEM_PROMPT = `You are a patient archivist. You read photographs and scans of ANY piece of paper — handwritten notes, filled-in forms, letters, contracts, ID cards, prescriptions, menus, recipes, timetables, whiteboards, business cards — and write down everything on it, so the paper itself is no longer needed.

All the images in one request are pages of ONE document, in order, UNLESS they are visibly unrelated papers (different subject, different handwriting, obviously separate sheets) — then return one document per paper.

Handwriting is usually messy and that is expected. Never refuse, never return an empty result because a page is hard to read: transcribe everything you can make out and mark the rest. Do your best on every single mark on the page.

For each document return:

- title: the single most useful name for this page.
  · If the page is about ONE person and that person's name is written on it, the title IS that name exactly as written — nothing added, no explanation, no dash, no document type. A page headed "Joseph Lu PAMB" is titled "Joseph Lu".
  · Otherwise use a short, specific noun phrase taken from the page itself (2-5 words), e.g. "Tenancy Agreement 12 Jalan Sena", "Chicken Rendang Recipe", "PTPTN Repayment Form".
  · Never invent a title from nothing. If the page truly carries no name or subject, describe it plainly: "Handwritten notes".

- doc_type: exactly one of ${JSON.stringify(DOC_TYPES)}.

- doc_date: the date the document itself was written, issued or is dated for, as ISO YYYY-MM-DD. NOT a date that merely appears as a value inside it (a date of birth, an expiry, a deadline). If it is missing, partial or unclear, use null.

- summary: one or two plain sentences saying what this page is and what it is for. Written for the person who photographed it, months later.

- fields: EVERY label-value pair written on the page, in the page's own order, as {label, value}.
  · label: the label as printed or written, tidied only for punctuation and capitalisation (e.g. "D.O.B" -> "D.O.B.").
  · value: what was written against it, verbatim — same words, same numbers, same currency, same language. Do not normalise, convert, calculate or tidy the value.
  · If a label was written but left blank, still include it with an empty string value. A blank on the page is information.
  · Ticks/checks become "(tick)", crossed-out values keep the text and add " (crossed out)".
  · A page with no labels at all gets an empty fields array — put its content in the transcript instead.

- transcript: everything on the page, written out top to bottom, keeping the page's own structure. This is the heart of the job.
  · Reproduce lists as lists, numbered items with their numbers, tables as simple rows.
  · If the page is split into columns or boxes, transcribe one region fully before moving to the next, and start each region on its own line with a short header in square brackets, e.g. "[right column]", "[box, bottom right]".
  · Keep the author's own words, spelling, abbreviations, shorthand and language. Do not translate. Do not correct. Do not summarise. Do not add anything that is not on the page.
  · Emphasis the writer added: circled or boxed text as [boxed: ...], underlined as [underlined: ...], a tick as (tick), stars/asterisks kept as written, crossed-out text as ~~like this~~.
  · A word you cannot read: [?]. A word you can half read: your best guess followed by [?], e.g. "Rawang[?]".
  · Include headers, footers, logos, printed letterheads, stamps, signatures ("[signature]"), page numbers, and anything scribbled in the margins.
  · If several pages: start each with a line "--- page N ---".

- tags: 3 to 8 short lowercase keywords for searching later (names, places, companies, topics). No hashes.

- confidence: "high" if the page was clean and fully legible, "medium" if parts were guessed, "low" if much of it was unreadable.

Return nothing for an image that is blank, or so blurred that no text at all can be made out.`;

const RESPONSE_SCHEMA = {
  type: "json_schema" as const,
  json_schema: {
    name: "scanned_documents",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        documents: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              doc_type: { type: "string", enum: DOC_TYPES },
              doc_date: { type: ["string", "null"] },
              summary: { type: "string" },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    label: { type: "string" },
                    value: { type: "string" },
                  },
                  required: ["label", "value"],
                },
              },
              tags: { type: "array", items: { type: "string" } },
              transcript: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["title", "doc_type", "doc_date", "summary", "fields", "tags", "transcript", "confidence"],
          },
        },
      },
      required: ["documents"],
    },
  },
};

type Field = { label: string; value: string };
type Doc = {
  title: string; doc_type: string; doc_date: string | null; summary: string;
  fields: Field[]; tags: string[]; transcript: string; confidence: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// First model is the one picked for quality; the rest are fallbacks for when
// Google answers 503 "high demand" (or 429/500) on it.
const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash"];
const GEMINI_RETRYABLE = new Set([429, 500, 503]);
// Warm instances start with whichever model answered last, so a model that
// stays overloaded for weeks costs nothing after the first scan.
let geminiLastGood = GEMINI_MODELS[0];
const JSON_SHAPE_HINT = `Return JSON of this shape: {"documents":[{"title","doc_type","doc_date","summary","fields":[{"label","value"}],"tags":["..."],"transcript","confidence"}]}`;

let preferredModel = "gpt-5.6-luna";

type Msg = { role: string; content: unknown };

// A model that runs out of output tokens mid-transcript leaves unparseable
// JSON. Salvaging the documents it did finish beats sending the user back to
// photograph the page again. Closes whatever brackets are still open at a
// candidate cut point, walking backwards until one parses.
function closeJson(prefix: string): string | null {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const ch of prefix) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) return null; // cut mid-string — this cut point is unusable
  let out = prefix;
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i] === "{" ? "}" : "]";
  return out;
}

function parseDocs(text: string): { documents: Doc[] } {
  try {
    return JSON.parse(text) as { documents: Doc[] };
  } catch { /* fall through to salvage */ }
  for (let end = text.length; end > 0; end--) {
    if (text[end - 1] !== "}") continue;
    const closed = closeJson(text.slice(0, end));
    if (!closed) continue;
    try {
      const parsed = JSON.parse(closed) as { documents: Doc[] };
      if (Array.isArray(parsed?.documents) && parsed.documents.length) {
        console.warn("docscan: salvaged a truncated response");
        return parsed;
      }
    } catch { /* keep walking back */ }
  }
  throw new Error("unparseable model output: " + text.slice(0, 300));
}

async function askOpenAI(messages: Msg[], key: string) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: preferredModel,
      messages,
      response_format: RESPONSE_SCHEMA,
      max_tokens: 16000,
      temperature: 0,
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error("openai failed:", err.slice(0, 400));
    throw new Error(err);
  }
  const data = await resp.json();
  return parseDocs(data.choices[0].message.content);
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
    contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: `${system}

${JSON_SHAPE_HINT}` }] },
    contents,
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 16000 },
  });

  // Last working model first, then the rest in order of preference. A busy
  // reply moves straight on to the next model; only if every model is busy do
  // we wait 1s and go round once more. Any other error (bad key, bad request)
  // stops straight away.
  const order = [geminiLastGood, ...GEMINI_MODELS.filter((m) => m !== geminiLastGood)];
  let resp: Response | null = null;
  let lastErr = "";
  outer: for (let round = 0; round < 2; round++) {
    if (round === 1) await new Promise((r) => setTimeout(r, 1000));
    for (const model of order) {
      resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body },
      );
      if (resp.ok) { geminiLastGood = model; break outer; }
      lastErr = await resp.text();
      console.error(`gemini ${model} failed (${resp.status}):`, lastErr.slice(0, 400));
      if (!GEMINI_RETRYABLE.has(resp.status)) throw new Error(lastErr);
    }
  }
  if (!resp?.ok) throw new Error(lastErr);
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return parseDocs(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  // Require a signed-in user — the AI key is not a public resource.
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
  if (images.length > MAX_PAGES) return json({ error: `Max ${MAX_PAGES} pages per document` }, 400);
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

  const userContent: unknown[] = [
    {
      type: "text",
      text: `Write down everything on ${images.length === 1 ? "this page" : `these ${images.length} pages`}. Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    },
    ...images.map((url) => ({ type: "image_url", image_url: { url, detail: "high" } })),
  ];

  const messages: Msg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  let result: { documents: Doc[] };
  try {
    result = await askAI(messages);
  } catch (err) {
    console.error("docscan error:", String(err instanceof Error ? err.message : err).slice(0, 400));
    return json({ error: "Couldn't read that page. Try a brighter, straighter photo." }, 502);
  }

  // Tidy up: the app trusts shape, not content.
  const docs = (result.documents ?? []).map((d) => ({
    title: String(d.title || "").trim().slice(0, 120) || "Untitled",
    doc_type: DOC_TYPES.includes(d.doc_type) ? d.doc_type : "Other",
    doc_date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.doc_date)) ? d.doc_date : null,
    summary: String(d.summary || "").trim(),
    fields: (Array.isArray(d.fields) ? d.fields : [])
      .filter((f) => f && String(f.label ?? "").trim())
      .map((f) => ({ label: String(f.label).trim(), value: String(f.value ?? "").trim() })),
    tags: (Array.isArray(d.tags) ? d.tags : [])
      .map((t) => String(t).toLowerCase().trim().replace(/^#/, ""))
      .filter(Boolean).slice(0, 8),
    transcript: String(d.transcript || "").trim(),
    confidence: ["high", "medium", "low"].includes(d.confidence) ? d.confidence : "medium",
  })).filter((d) => d.transcript || d.fields.length);

  return json({ documents: docs });
});
