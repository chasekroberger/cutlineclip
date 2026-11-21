/* Auto captions: turns a clip's speech into timed words with Cloudflare Workers AI (Whisper).
   Needs the AI binding in wrangler.jsonc. The browser sends only the clip's audio, as a small 16 kHz WAV. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; /* about 4 minutes of 16 kHz mono audio */
const DAILY_LIMIT = 60;
const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

let tableReady = false;
async function ensureTable(env) {
  if (tableReady) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS caption_uses (user_id TEXT NOT NULL, at INTEGER NOT NULL)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS caption_uses_user ON caption_uses (user_id, at)").run();
  tableReady = true;
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(s);
}

/* Whisper returns segments with words. Older answers may have only segment text, so those words are spread evenly. */
export function wordsFrom(result) {
  const out = [];
  for (const seg of (result && result.segments) || []) {
    const words = Array.isArray(seg.words) ? seg.words : [];
    if (words.length) { for (const w of words) { const t = String(w.word || "").trim(); if (t) out.push({ w: t, s: +w.start || 0, e: +w.end || +w.start || 0 }); } continue; }
    const parts = String(seg.text || "").trim().split(/\s+/).filter(Boolean), s = +seg.start || 0, e = +seg.end || s;
    parts.forEach((t, i) => out.push({ w: t, s: s + (e - s) * i / parts.length, e: s + (e - s) * (i + 1) / parts.length }));
  }
  if (!out.length && result && Array.isArray(result.words)) for (const w of result.words) { const t = String(w.word || "").trim(); if (t) out.push({ w: t, s: +w.start || 0, e: +w.end || 0 }); }
  return out.slice(0, 2000);
}

export async function makeCaptions(request, env, user) {
  if (!env.AI) return json({ ok: false, code: "not_set_up", message: "Auto captions aren't switched on for this site yet." }, 503);
  const type = String(request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (type !== "audio/wav") return json({ ok: false, message: "Send the clip's audio as WAV." }, 415);
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length < 1000) return json({ ok: false, message: "This clip has no sound to caption." }, 400);
  if (buf.length > MAX_AUDIO_BYTES) return json({ ok: false, message: "Auto captions work on clips up to 4 minutes. Trim the clip and try again." }, 413);
  await ensureTable(env);
  const since = Date.now() - 864e5;
  const used = await env.DB.prepare("SELECT COUNT(*) n FROM caption_uses WHERE user_id = ? AND at > ?").bind(user.id, since).first();
  if (!user.is_admin && used && used.n >= DAILY_LIMIT) return json({ ok: false, code: "limit", message: "You've used auto captions " + DAILY_LIMIT + " times today. Try again tomorrow." }, 429);
  let result;
  try {
    result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: toBase64(buf), task: "transcribe", vad_filter: true });
  } catch (e) {
    console.error("Auto captions failed:", e && e.message);
    return json({ ok: false, message: "Auto captions couldn't hear this clip right now. Try again in a minute." }, 502);
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO caption_uses (user_id, at) VALUES (?, ?)").bind(user.id, Date.now()),
    env.DB.prepare("DELETE FROM caption_uses WHERE at < ?").bind(since - 864e5)
  ]);
  const words = wordsFrom(result);
  return json({ ok: true, words: words, language: (result && result.transcription_info && result.transcription_info.language) || "" });
}
