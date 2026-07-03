// Proxies "Say it" phrasing/translation requests to Gemini using a
// server-side key, so visitors never need a Gemini API key of their own.
//
// Setup: Netlify site -> Site settings -> Environment variables ->
// add GEMINI_API_KEY (get a free one at https://aistudio.google.com/apikey).
// If Google renames/retires the model below, update GEMINI_MODEL to
// whatever "flash" model is current at aistudio.google.com.

const GEMINI_MODEL = "gemini-2.0-flash";
const MAX_INSTRUCTION_CHARS = 4000; // bounds the cost of a single request
const MAX_OUTPUT_TOKENS = 1000;

// Best-effort per-instance rate limit: a speed bump against a script
// hammering this endpoint, not a hard guarantee — the map resets on
// cold start and isn't shared across concurrent instances. If this
// gets real traffic and real abuse, replace it with Netlify Blobs or
// a small Redis (e.g. Upstash's free tier) for a limit that actually
// holds across instances.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;
const hits = new Map(); // ip -> timestamps[]

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_PER_WINDOW;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    event.headers["client-ip"] ||
    "unknown";
  if (rateLimited(ip)) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "Too many requests — wait a minute and try again." })
    };
  }

  let instruction;
  try {
    ({ instruction } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body." }) };
  }
  if (!instruction || typeof instruction !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'instruction'." }) };
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return { statusCode: 400, body: JSON.stringify({ error: "Request too long." }) };
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server is missing GEMINI_API_KEY." }) };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: instruction }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS }
      })
    }
  );
  const data = await res.json();
  if (!res.ok) {
    return {
      statusCode: res.status,
      body: JSON.stringify({ error: data?.error?.message || "Gemini request failed." })
    };
  }

  const candidate = data.candidates?.[0];
  const text = candidate
    ? (candidate.content?.parts || []).map((p) => p.text || "").join("\n")
    : "";
  if (!text) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Gemini returned no reply (possibly blocked by safety filters)." })
    };
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  };
};
