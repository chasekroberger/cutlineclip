/* Connected accounts, saved clips, and the upload queue.
   Clips are kept in D1 in small pieces until every upload for them is done, then deleted.
   A Cloudflare cron runs runQueue() every minute to post clips when their time comes. */
import * as S from "./social.js";

const CHUNK = 1800000; /* D1 rows hold up to about 2 MB */
const MAX_CLIP_BYTES = 60 * 1024 * 1024;
const QUEUE_GAPS = [0, 15, 30, 60, 180];
const MAX_SCHEDULE_DAYS = 30;
const STUCK_MS = 20 * 60 * 1000;
const PROCESS_LIMIT_MS = 45 * 60 * 1000;

const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const fail = (status, code, message) => json({ ok: false, code: code, message: message }, status);
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
const token = (n) => hex(crypto.getRandomValues(new Uint8Array(n || 24)));

/* Tables are created on first use, so no manual migration step is needed. */
let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS connections (user_id TEXT NOT NULL, platform TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL, access_token TEXT, refresh_token TEXT, expires_at INTEGER, auto_upload INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY (user_id, platform))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, clip_id TEXT NOT NULL, platform TEXT NOT NULL, status TEXT NOT NULL, options TEXT NOT NULL, message TEXT NOT NULL DEFAULT '', remote_url TEXT NOT NULL DEFAULT '', remote_id TEXT, media_token TEXT, scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS posts_due ON posts (status, scheduled_at)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, updated_at)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS clip_files (clip_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL, created_at INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS clip_chunks (clip_id TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (clip_id, n))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS queue_settings (user_id TEXT PRIMARY KEY, gap INTEGER NOT NULL DEFAULT 0)")
  ]);
  schemaReady = true;
}

/* ---------- Clip files ---------- */
async function saveClip(request, env, user, url) {
  const type = String(request.headers.get("Content-Type") || "").split(";")[0].trim();
  if (type !== "video/mp4" && type !== "video/webm") return fail(415, "bad_type", "Upload an MP4 or WebM clip.");
  if (Number(request.headers.get("Content-Length") || 0) > MAX_CLIP_BYTES) return fail(413, "too_large", "That clip is too big to post. Keep clips under 60 MB.");
  const id = String(url.searchParams.get("id") || "");
  const claim = await env.DB.prepare("SELECT id FROM claims WHERE id = ? AND user_id = ? AND released = 0").bind(id, user.id).first();
  if (!claim) return fail(404, "no_clip", "Export the clip again, then post it.");
  if (await env.DB.prepare("SELECT 1 FROM clip_files WHERE clip_id = ?").bind(id).first()) return json({ ok: true });
  await env.DB.prepare("DELETE FROM clip_chunks WHERE clip_id = ?").bind(id).run();
  const reader = request.body.getReader();
  let buf = new Uint8Array(CHUNK), fill = 0, n = 0, size = 0;
  const flush = async () => { if (!fill) return; await env.DB.prepare("INSERT INTO clip_chunks (clip_id, n, data) VALUES (?, ?, ?)").bind(id, n, buf.slice(0, fill)).run(); n += 1; fill = 0; };
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      let v = r.value, off = 0;
      size += v.length;
      if (size > MAX_CLIP_BYTES) throw new Error("too_large");
      while (off < v.length) {
        const take = Math.min(CHUNK - fill, v.length - off);
        buf.set(v.subarray(off, off + take), fill); fill += take; off += take;
        if (fill === CHUNK) await flush();
      }
    }
    await flush();
  } catch (e) {
    await env.DB.prepare("DELETE FROM clip_chunks WHERE clip_id = ?").bind(id).run();
    return e.message === "too_large" ? fail(413, "too_large", "That clip is too big to post. Keep clips under 60 MB.") : fail(400, "upload_failed", "The clip didn't finish uploading. Try again.");
  }
  if (size < 1024) { await env.DB.prepare("DELETE FROM clip_chunks WHERE clip_id = ?").bind(id).run(); return fail(400, "empty", "That clip is empty. Export it again."); }
  await env.DB.prepare("INSERT INTO clip_files (clip_id, user_id, mime, size, chunks, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, user.id, type, size, n, Date.now()).run();
  return json({ ok: true });
}
function clipStream(env, file) {
  let n = 0;
  return new ReadableStream({
    async pull(ctrl) {
      if (n >= file.chunks) { ctrl.close(); return; }
      const r = await env.DB.prepare("SELECT data FROM clip_chunks WHERE clip_id = ? AND n = ?").bind(file.clip_id, n).first();
      n += 1;
      if (!r) { ctrl.error(new Error("missing piece")); return; }
      ctrl.enqueue(new Uint8Array(r.data));
    }
  });
}
/* Platforms need to know the size up front, so the stream gets a fixed length on Cloudflare. */
function sizedBody(env, file) {
  const s = clipStream(env, file);
  if (typeof FixedLengthStream !== "function") return s;
  const f = new FixedLengthStream(file.size);
  s.pipeTo(f.writable).catch(function () {});
  return f.readable;
}
async function deleteClip(env, clipId) {
  await env.DB.batch([env.DB.prepare("DELETE FROM clip_chunks WHERE clip_id = ?").bind(clipId), env.DB.prepare("DELETE FROM clip_files WHERE clip_id = ?").bind(clipId)]);
}

/* ---------- Accounts ---------- */
async function connectionsFor(env, userId) {
  const { results } = await env.DB.prepare("SELECT platform, account_name, auto_upload FROM connections WHERE user_id = ?").bind(userId).all();
  return S.PLATFORMS.map(function (p) {
    const r = results.find((x) => x.platform === p);
    return { platform: p, name: S.NAMES[p], available: S.enabled(env, p), connected: Boolean(r), accountName: r ? r.account_name : "", autoUpload: Boolean(r && r.auto_upload && p !== "tiktok") };
  });
}
async function accessToken(env, conn) {
  const early = conn.platform === "instagram" ? 7 * 864e5 : 2 * 60 * 1000;
  if (conn.expires_at && conn.expires_at - Date.now() < early) {
    try {
      const t = await S.refresh(env, conn.platform, { accessToken: await S.decrypt(env, conn.access_token), refreshToken: await S.decrypt(env, conn.refresh_token) });
      await env.DB.prepare("UPDATE connections SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ? WHERE user_id = ? AND platform = ?")
        .bind(await S.encrypt(env, t.accessToken), t.refreshToken ? await S.encrypt(env, t.refreshToken) : null, t.expiresAt, conn.user_id, conn.platform).run();
      return t.accessToken;
    } catch (e) {
      if (conn.expires_at > Date.now()) return S.decrypt(env, conn.access_token);
      throw new S.PlatformError("Reconnect your " + S.NAMES[conn.platform] + " account to keep uploading.", { reconnect: true });
    }
  }
  return S.decrypt(env, conn.access_token);
}

/* ---------- Queue ---------- */
async function queueGap(env, userId) {
  const r = await env.DB.prepare("SELECT gap FROM queue_settings WHERE user_id = ?").bind(userId).first();
  return r ? Number(r.gap) : 0;
}
async function recentPosts(env, userId) {
  const cols = "SELECT id, clip_id clipId, platform, status, message, remote_url url, options, scheduled_at scheduledAt, created_at createdAt FROM posts WHERE user_id = ?";
  const q = await env.DB.prepare(cols + " AND status = 'queued' ORDER BY scheduled_at, created_at LIMIT 100").bind(userId).all();
  const rest = await env.DB.prepare(cols + " AND status <> 'queued' ORDER BY updated_at DESC LIMIT 12").bind(userId).all();
  return q.results.concat(rest.results).map(function (p) {
    const o = JSON.parse(p.options); delete p.options;
    if (p.status === "processing") p.status = "uploading";
    p.name = S.NAMES[p.platform]; p.caption = o.caption || "";
    return p;
  });
}
async function nextSlot(env, userId) {
  const gap = await queueGap(env, userId);
  if (!gap) return Date.now();
  const r = await env.DB.prepare("SELECT MAX(scheduled_at) t FROM posts WHERE user_id = ? AND status <> 'failed'").bind(userId).first();
  return r && r.t ? Math.max(Date.now(), Number(r.t) + gap * 60000) : Date.now();
}
function checkTime(value) {
  const t = Number(value);
  if (!Number.isFinite(t)) return { error: "Pick a date and time." };
  if (t < Date.now() - 60000) return { error: "That time has already passed. Pick a time in the future." };
  if (t > Date.now() + MAX_SCHEDULE_DAYS * 864e5) return { error: "Pick a time in the next " + MAX_SCHEDULE_DAYS + " days." };
  return { time: Math.max(Date.now(), Math.round(t)) };
}

/* ---------- Pages outside /api ---------- */
export async function socialPage(request, env, url, user) {
  let m = /^\/connect\/(youtube|tiktok|instagram)$/.exec(url.pathname);
  if (m && request.method === "GET") {
    await ensureSchema(env);
    if (!user) return redirect("/#login");
    if (!S.enabled(env, m[1])) return redirect("/?connect=unavailable&platform=" + m[1] + "#accounts");
    const state = token(24);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(Date.now()),
      env.DB.prepare("INSERT INTO oauth_states (state_hash, user_id, platform, expires_at) VALUES (?, ?, ?, ?)").bind(await sha(state), user.id, m[1], Date.now() + 10 * 60 * 1000)
    ]);
    return redirect(S.authUrl(env, m[1], state));
  }
  m = /^\/oauth\/(youtube|tiktok|instagram)\/callback$/.exec(url.pathname);
  if (m && request.method === "GET") {
    await ensureSchema(env);
    const p = m[1], back = (q) => redirect("/?" + q + "&platform=" + p + "#accounts");
    if (!user) return redirect("/#login");
    const hash = await sha(url.searchParams.get("state") || "");
    const row = await env.DB.prepare("SELECT * FROM oauth_states WHERE state_hash = ?").bind(hash).first();
    if (row) await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(hash).run();
    if (!row || row.user_id !== user.id || row.platform !== p || row.expires_at < Date.now()) return back("connect=expired");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error") || !code) return back("connect=denied");
    try {
      const t = await S.exchange(env, p, code);
      await env.DB.prepare("INSERT INTO connections (user_id, platform, account_id, account_name, access_token, refresh_token, expires_at, auto_upload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, platform) DO UPDATE SET account_id = excluded.account_id, account_name = excluded.account_name, access_token = excluded.access_token, refresh_token = COALESCE(excluded.refresh_token, connections.refresh_token), expires_at = excluded.expires_at")
        .bind(user.id, p, String(t.accountId), String(t.accountName).slice(0, 120), await S.encrypt(env, t.accessToken), await S.encrypt(env, t.refreshToken), t.expiresAt, p === "tiktok" ? 0 : 1, Date.now()).run();
      return back("connected=1");
    } catch (e) {
      console.error("Connecting " + p + " failed: " + e.message);
      return back("connect=failed");
    }
  }
  /* Instagram downloads the clip from here while it processes the post. */
  m = /^\/media\/([0-9a-f]{48})\.mp4$/.exec(url.pathname);
  if (m && (request.method === "GET" || request.method === "HEAD")) {
    await ensureSchema(env);
    const file = await env.DB.prepare("SELECT f.* FROM posts p JOIN clip_files f ON f.clip_id = p.clip_id WHERE p.media_token = ? AND p.status IN ('uploading', 'processing')").bind(m[1]).first();
    if (!file) return new Response("Not found", { status: 404 });
    const headers = { "Content-Type": file.mime, "Content-Length": String(file.size), "Cache-Control": "no-store" };
    return new Response(request.method === "HEAD" ? null : sizedBody(env, file), { headers: headers });
  }
  return null;
}

/* ---------- API ---------- */
export async function socialApi(route, request, env, ctx, url, user, body) {
  await ensureSchema(env);
  const kick = () => { if (ctx && ctx.waitUntil) ctx.waitUntil(runQueue(env).catch((e) => console.error("Queue run failed:", e && e.stack || e))); };
  switch (route) {
    case "POST /api/clips/file": return saveClip(request, env, user, url);
    case "GET /api/connections": return json({ ok: true, connections: await connectionsFor(env, user.id), posts: await recentPosts(env, user.id), queueGap: await queueGap(env, user.id) });
    case "GET /api/posts": return json({ ok: true, posts: await recentPosts(env, user.id) });
    case "POST /api/settings/queue": {
      const gap = Number(body.gap);
      if (!QUEUE_GAPS.includes(gap)) return fail(400, "bad_gap", "Choose how far apart new uploads should be.");
      await env.DB.prepare("INSERT INTO queue_settings (user_id, gap) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET gap = excluded.gap").bind(user.id, gap).run();
      return json({ ok: true, queueGap: gap });
    }
    case "POST /api/posts/schedule": {
      const t = checkTime(body.scheduleAt);
      if (t.error) return fail(400, "bad_time", t.error);
      const r = await env.DB.prepare("UPDATE posts SET scheduled_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'queued'").bind(t.time, Date.now(), String(body.id || ""), user.id).run();
      if (!r.meta.changes) return fail(409, "not_queued", "That upload already started, so its time can't change.");
      if (t.time <= Date.now() + 1000) kick();
      return json({ ok: true, posts: await recentPosts(env, user.id) });
    }
    case "POST /api/posts/now": {
      const r = await env.DB.prepare("UPDATE posts SET scheduled_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'queued'").bind(Date.now(), Date.now(), String(body.id || ""), user.id).run();
      if (!r.meta.changes) return fail(409, "not_queued", "That upload already started.");
      kick();
      return json({ ok: true, posts: await recentPosts(env, user.id) });
    }
    case "POST /api/posts/remove": {
      const r = await env.DB.prepare("DELETE FROM posts WHERE id = ? AND user_id = ? AND status = 'queued'").bind(String(body.id || ""), user.id).run();
      if (!r.meta.changes) return fail(409, "not_queued", "That upload already started, so it can't be removed from the queue.");
      return json({ ok: true, posts: await recentPosts(env, user.id) });
    }
    case "POST /api/connections/auto": {
      if (body.platform !== "youtube" && body.platform !== "instagram") return fail(400, "bad_platform", "Auto upload is available for YouTube and Instagram.");
      await env.DB.prepare("UPDATE connections SET auto_upload = ? WHERE user_id = ? AND platform = ?").bind(body.on ? 1 : 0, user.id, body.platform).run();
      return json({ ok: true, connections: await connectionsFor(env, user.id) });
    }
    case "POST /api/connections/disconnect": {
      const p = String(body.platform || "");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM connections WHERE user_id = ? AND platform = ?").bind(user.id, p),
        env.DB.prepare("UPDATE posts SET status = 'failed', message = 'Removed because the account was disconnected.', updated_at = ? WHERE user_id = ? AND platform = ? AND status = 'queued'").bind(Date.now(), user.id, p)
      ]);
      return json({ ok: true, connections: await connectionsFor(env, user.id) });
    }
    case "GET /api/tiktok/creator": {
      const conn = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? AND platform = 'tiktok'").bind(user.id).first();
      if (!conn) return fail(400, "not_connected", "Connect your TikTok account first.");
      try {
        const d = await S.tiktokCreator(env, await accessToken(env, conn));
        return json({ ok: true, creator: { nickname: d.creator_nickname || d.creator_username || conn.account_name, privacyOptions: (d.privacy_level_options || []).filter((x) => S.TIKTOK_PRIVACY.includes(x)), commentDisabled: Boolean(d.comment_disabled), duetDisabled: Boolean(d.duet_disabled), stitchDisabled: Boolean(d.stitch_disabled), maxDuration: Number(d.max_video_post_duration_sec || 0) } });
      } catch (e) {
        if (!(e instanceof S.PlatformError)) throw e;
        return fail(502, "tiktok_unavailable", e.message.startsWith("TikTok") || e.message.startsWith("Reconnect") ? e.message : "TikTok can't take new posts from your account right now. Try again later.");
      }
    }
    case "POST /api/posts": return createPosts(env, user, body, kick);
  }
  return null;
}

async function createPosts(env, user, body, kick) {
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM posts WHERE user_id = ? AND created_at > ?").bind(user.id, Date.now() - 3600000).first();
  if (recent && recent.n >= 120) return fail(429, "rate_limited", "Too many posts at once. Wait a bit and try again.");
  const clipId = String(body.clipId || "");
  const file = await env.DB.prepare("SELECT * FROM clip_files WHERE clip_id = ? AND user_id = ?").bind(clipId, user.id).first();
  if (!file) return fail(400, "no_clip", "Export your clip first, then post it.");
  const caption = String(body.caption || "").trim().slice(0, 2200);
  const targets = body.targets && typeof body.targets === "object" ? body.targets : {};
  const chosen = Object.keys(targets).filter((p) => S.PLATFORMS.includes(p));
  if (!chosen.length) return fail(400, "no_targets", "Choose at least one account to post to.");
  const jobs = [];
  for (const p of chosen) {
    const name = S.NAMES[p];
    if (!await env.DB.prepare("SELECT 1 FROM connections WHERE user_id = ? AND platform = ?").bind(user.id, p).first()) return fail(400, "not_connected", "Connect your " + name + " account first.");
    if (await env.DB.prepare("SELECT 1 FROM posts WHERE clip_id = ? AND platform = ? AND status <> 'failed'").bind(clipId, p).first()) return fail(409, "already_posted", "This clip is already queued or posted to " + name + ".");
    const t = targets[p] || {};
    let opts;
    if (p === "youtube") {
      if (!["public", "unlisted", "private"].includes(t.privacy)) return fail(400, "bad_privacy", "Choose who can watch your YouTube video.");
      opts = { caption: caption, privacy: t.privacy };
    } else if (p === "instagram") {
      if (file.mime !== "video/mp4") return fail(400, "needs_mp4", "Instagram needs an MP4 clip. Export it again in the latest Chrome or Edge.");
      opts = { caption: caption };
    } else {
      if (t.consent !== true) return fail(400, "consent_required", "Agree to TikTok's posting terms before posting.");
      if (!S.TIKTOK_PRIVACY.includes(t.privacy)) return fail(400, "bad_privacy", "Choose who can see your TikTok post.");
      if (t.disclose && !t.yourBrand && !t.branded) return fail(400, "bad_disclosure", "Choose Your brand, Branded content, or both.");
      if (t.disclose && t.branded && t.privacy === "SELF_ONLY") return fail(400, "bad_disclosure", "Branded content can't be private on TikTok. Choose another privacy setting.");
      opts = { caption: caption, privacy: t.privacy, allowComment: Boolean(t.allowComment), allowDuet: Boolean(t.allowDuet), allowStitch: Boolean(t.allowStitch), yourBrand: Boolean(t.disclose && t.yourBrand), branded: Boolean(t.disclose && t.branded) };
    }
    jobs.push([p, opts]);
  }
  let slot;
  if (body.scheduleAt !== undefined && body.scheduleAt !== null) { const t = checkTime(body.scheduleAt); if (t.error) return fail(400, "bad_time", t.error); slot = t.time; }
  else slot = await nextSlot(env, user.id);
  const now = Date.now();
  await env.DB.batch(jobs.map(([p, opts]) => env.DB.prepare("INSERT INTO posts (id, user_id, clip_id, platform, status, options, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)").bind(crypto.randomUUID(), user.id, clipId, p, JSON.stringify(opts), slot, now, now)));
  if (slot <= Date.now() + 1000) kick();
  return json({ ok: true, posts: await recentPosts(env, user.id) });
}

/* ---------- The job that posts ---------- */
export async function runQueue(env) {
  await ensureSchema(env);
  const now = Date.now();
  await env.DB.prepare("UPDATE posts SET status = 'failed', message = 'The upload stopped partway. Add it to the queue again.', media_token = NULL, updated_at = ? WHERE status = 'uploading' AND updated_at < ?").bind(now, now - STUCK_MS).run();
  /* Check on clips the platforms are still processing. */
  const waiting = await env.DB.prepare("SELECT * FROM posts WHERE status = 'processing' ORDER BY updated_at LIMIT 10").all();
  for (const job of waiting.results) await checkProcessing(env, job);
  /* Start the next upload that's due. One per run keeps each run small; the cron runs every minute. */
  for (let i = 0; i < 2; i++) {
    const job = await env.DB.prepare("SELECT * FROM posts WHERE status = 'queued' AND scheduled_at <= ? ORDER BY scheduled_at, created_at LIMIT 1").bind(Date.now()).first();
    if (!job) break;
    const r = await env.DB.prepare("UPDATE posts SET status = 'uploading', updated_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now(), job.id).run();
    if (r.meta.changes) await startJob(env, job);
  }
  await cleanUp(env);
}
async function finish(env, job, status, message, url) {
  await env.DB.prepare("UPDATE posts SET status = ?, message = ?, remote_url = ?, media_token = NULL, updated_at = ? WHERE id = ?").bind(status, message || "", url || "", Date.now(), job.id).run();
}
async function startJob(env, job) {
  try {
    const file = await env.DB.prepare("SELECT * FROM clip_files WHERE clip_id = ?").bind(job.clip_id).first();
    const conn = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? AND platform = ?").bind(job.user_id, job.platform).first();
    if (!file) throw new S.PlatformError("The clip file is no longer saved. Export it again.");
    if (!conn) throw new S.PlatformError("Connect your " + S.NAMES[job.platform] + " account, then post again.");
    const opts = JSON.parse(job.options), tok = await accessToken(env, conn), body = () => sizedBody(env, file);
    if (job.platform === "youtube") {
      const out = await S.publishYouTube(env, tok, file, body, opts);
      return finish(env, job, "posted", "", out.url);
    }
    if (job.platform === "tiktok") {
      const info = await S.tiktokCreator(env, tok);
      if (!(info.privacy_level_options || []).includes(opts.privacy)) throw new S.PlatformError("That TikTok privacy setting isn't available for your account. Post again and choose another one.");
      const id = await S.startTikTok(env, tok, file, body, opts);
      await env.DB.prepare("UPDATE posts SET status = 'processing', remote_id = ?, updated_at = ? WHERE id = ?").bind(String(id), Date.now(), job.id).run();
      return;
    }
    const media = token(24);
    await env.DB.prepare("UPDATE posts SET media_token = ? WHERE id = ?").bind(media, job.id).run();
    const container = await S.startInstagram(env, tok, conn.account_id, S.siteUrl(env) + "/media/" + media + ".mp4", opts.caption);
    await env.DB.prepare("UPDATE posts SET status = 'processing', remote_id = ?, updated_at = ? WHERE id = ?").bind(String(container), Date.now(), job.id).run();
  } catch (e) {
    if (!(e instanceof S.PlatformError)) console.error(e && e.stack || e);
    await finish(env, job, "failed", e instanceof S.PlatformError ? e.message : "The upload failed. Add it to the queue again.");
  }
}
async function checkProcessing(env, job) {
  try {
    const conn = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? AND platform = ?").bind(job.user_id, job.platform).first();
    if (!conn) throw new S.PlatformError("The account was disconnected before the post finished.");
    const tok = await accessToken(env, conn);
    const s = job.platform === "tiktok" ? await S.tiktokStatus(env, tok, job.remote_id) : await S.instagramStatus(env, tok, conn.account_id, job.remote_id);
    if (s.done) return finish(env, job, "posted", "", s.url);
    if (Date.now() - job.updated_at > PROCESS_LIMIT_MS) throw new S.PlatformError(S.NAMES[job.platform] + " is taking too long to process the clip. Check your profile, then post again if it isn't there.");
  } catch (e) {
    if (!(e instanceof S.PlatformError)) console.error(e && e.stack || e);
    await finish(env, job, "failed", e instanceof S.PlatformError ? e.message : "The upload failed. Add it to the queue again.");
  }
}
/* Saved clips are deleted once nothing is waiting to post them, and after 3 days if they were never posted. */
async function cleanUp(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT f.clip_id FROM clip_files f WHERE NOT EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = f.clip_id AND p.status IN ('queued', 'uploading', 'processing')) AND (f.created_at < ? OR EXISTS (SELECT 1 FROM posts p WHERE p.clip_id = f.clip_id AND p.updated_at < ?)) LIMIT 20").bind(now - 3 * 864e5, now - 6 * 3600000).all();
  for (const r of results) await deleteClip(env, r.clip_id);
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(now).run();
}

/* Removes everything for a deleted account. */
export async function deleteUserData(env, userId) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare("SELECT clip_id FROM clip_files WHERE user_id = ?").bind(userId).all();
  for (const r of results) await deleteClip(env, r.clip_id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM posts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM connections WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM queue_settings WHERE user_id = ?").bind(userId)
  ]);
}
