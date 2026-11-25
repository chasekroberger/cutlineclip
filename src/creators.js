/* Creators who want to be clipped share their channel and a folder of videos.
   Requests wait for an admin to check that the channel really belongs to them. */
const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const MAX_OPEN = 5;

async function ensureTable(env) {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS creator_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, channel TEXT NOT NULL, folder TEXT NOT NULL, rules TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL)").run();
}

function cleanLink(v) {
  let s = String(v || "").trim();
  if (!s || s.length > 500) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { const u = new URL(s); if (u.protocol !== "https:" && u.protocol !== "http:") return ""; if (!u.hostname.includes(".")) return ""; return u.toString(); } catch (e) { return ""; }
}

export async function creatorRequest(env, user, body) {
  const channel = cleanLink(body.channel), folder = cleanLink(body.folder), rules = String(body.rules || "").trim().slice(0, 500);
  if (!channel) return json({ ok: false, message: "Paste your channel link, like youtube.com/@yourname." }, 400);
  if (!folder) return json({ ok: false, message: "Paste the share link to your Google Drive or Dropbox folder." }, 400);
  if (body.owns !== true) return json({ ok: false, message: "Check the box to confirm you own these videos." }, 400);
  await ensureTable(env);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM creator_requests WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
  if ((open && open.n) >= MAX_OPEN) return json({ ok: false, message: "You already have " + MAX_OPEN + " requests waiting. We'll check them soon." }, 429);
  await env.DB.prepare("INSERT INTO creator_requests (id, user_id, email, channel, folder, rules, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
    .bind(crypto.randomUUID(), user.id, user.email, channel, folder, rules, new Date().toISOString()).run();
  return json({ ok: true, message: "Thanks! We'll check that the channel is yours, then email you when clippers can use your videos." });
}

export async function adminCreators(env) {
  await ensureTable(env);
  const r = await env.DB.prepare("SELECT id, email, channel, folder, rules, status, created_at AS createdAt FROM creator_requests ORDER BY created_at DESC LIMIT 200").all();
  return json({ ok: true, creators: r.results || [] });
}

export async function adminCreatorStatus(env, body) {
  const status = body.status === "approved" ? "approved" : body.status === "declined" ? "declined" : "";
  if (!status || !body.id) return json({ ok: false, message: "Pick approve or decline." }, 400);
  await ensureTable(env);
  const r = await env.DB.prepare("UPDATE creator_requests SET status = ? WHERE id = ?").bind(status, String(body.id)).run();
  if (!r.meta || !r.meta.changes) return json({ ok: false, message: "That request wasn't found." }, 404);
  return json({ ok: true });
}
