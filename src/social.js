/* Talks to YouTube, TikTok, and Instagram. Each platform turns on only when its keys are set in Cloudflare:
   TOKEN_KEY (any random text, 32+ characters), YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET. */

export const NAMES = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };
export const PLATFORMS = Object.keys(NAMES);
export const TIKTOK_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"];
const IG_VERSION = "v23.0";
const HOSTS = {
  google_auth: "https://accounts.google.com",
  google_token: "https://oauth2.googleapis.com",
  youtube: "https://www.googleapis.com",
  tiktok_auth: "https://www.tiktok.com",
  tiktok: "https://open.tiktokapis.com",
  ig_auth: "https://www.instagram.com",
  ig_token: "https://api.instagram.com",
  ig_graph: "https://graph.instagram.com"
};
/* CUTLINE_TEST_API_BASE is for local testing only. Never set it on the live site. */
const host = (env, name) => (env.CUTLINE_TEST_API_BASE ? env.CUTLINE_TEST_API_BASE + "/" + name : HOSTS[name]);
export const siteUrl = (env) => String(env.PUBLIC_URL || "https://cutlineclip.com").replace(/\/+$/, "");
const redirectUri = (env, p) => siteUrl(env) + "/oauth/" + p + "/callback";
function creds(env, p) {
  if (p === "youtube") return { id: env.YOUTUBE_CLIENT_ID, secret: env.YOUTUBE_CLIENT_SECRET };
  if (p === "tiktok") return { id: env.TIKTOK_CLIENT_KEY, secret: env.TIKTOK_CLIENT_SECRET };
  return { id: env.INSTAGRAM_APP_ID, secret: env.INSTAGRAM_APP_SECRET };
}
export function enabled(env, p) {
  const c = creds(env, p);
  return Boolean(String(env.TOKEN_KEY || "").length >= 32 && c.id && c.secret);
}

export class PlatformError extends Error {
  constructor(message, opts) { super(message); this.reconnect = Boolean(opts && opts.reconnect); }
}

/* Platform logins are stored encrypted with TOKEN_KEY. */
let keyCache = null;
async function aesKey(env) {
  if (keyCache && keyCache.src === env.TOKEN_KEY) return keyCache.key;
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TOKEN_KEY));
  keyCache = { src: env.TOKEN_KEY, key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]) };
  return keyCache.key;
}
const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function encrypt(env, text) {
  if (text === null || text === undefined || text === "") return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), new TextEncoder().encode(String(text))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
export async function decrypt(env, blob) {
  if (!blob) return null;
  const b = unb64(blob);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12) }, await aesKey(env), b.subarray(12)));
}

const form = (o) => new URLSearchParams(o).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
async function call(url, opts) {
  opts = opts || {};
  let res;
  try { res = await fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(opts.timeout || 60000) })); }
  catch (e) { throw new PlatformError("Couldn't reach the platform. It will try again soon."); }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, data: data, headers: res.headers };
}
function failFrom(name, r, fallback) {
  const d = r.data || {}, e = d.error;
  const msg = (e && typeof e === "object" ? e.message || e.error_user_msg : e) || d.error_description || d.error_message || d.message || "";
  console.error(name + " error " + r.status + ": " + JSON.stringify(d).slice(0, 500));
  throw new PlatformError(fallback + (msg ? " " + name + " said: " + String(msg).slice(0, 160) : ""), { reconnect: r.status === 401 });
}
const expiry = (seconds) => (seconds ? Date.now() + Number(seconds) * 1000 : null);

export function authUrl(env, p, state) {
  const c = creds(env, p);
  if (p === "youtube") return host(env, "google_auth") + "/o/oauth2/v2/auth?" + form({ client_id: c.id, redirect_uri: redirectUri(env, p), response_type: "code", scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: state });
  if (p === "tiktok") return host(env, "tiktok_auth") + "/v2/auth/authorize/?" + form({ client_key: c.id, scope: "user.info.basic,video.publish", response_type: "code", redirect_uri: redirectUri(env, p), state: state });
  return host(env, "ig_auth") + "/oauth/authorize?" + form({ client_id: c.id, redirect_uri: redirectUri(env, p), response_type: "code", scope: "instagram_business_basic,instagram_business_content_publish", state: state });
}

export async function exchange(env, p, code) {
  const c = creds(env, p);
  if (p === "youtube") {
    const t = await call(host(env, "google_token") + "/token", { method: "POST", headers: FORM, body: form({ code: code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri(env, p), grant_type: "authorization_code" }) });
    if (!t.ok || !t.data.access_token) failFrom("YouTube", t, "YouTube didn't finish connecting.");
    const ch = await call(host(env, "youtube") + "/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: "Bearer " + t.data.access_token } });
    if (!ch.ok) failFrom("YouTube", ch, "Couldn't read your YouTube channel.");
    const item = (ch.data.items || [])[0];
    if (!item) throw new PlatformError("This Google account doesn't have a YouTube channel yet. Create one on YouTube, then connect again.");
    return { accessToken: t.data.access_token, refreshToken: t.data.refresh_token || null, expiresAt: expiry(t.data.expires_in), accountId: item.id, accountName: item.snippet.title };
  }
  if (p === "tiktok") {
    const t = await call(host(env, "tiktok") + "/v2/oauth/token/", { method: "POST", headers: FORM, body: form({ client_key: c.id, client_secret: c.secret, code: code, grant_type: "authorization_code", redirect_uri: redirectUri(env, p) }) });
    if (!t.ok || !t.data.access_token) failFrom("TikTok", t, "TikTok didn't finish connecting.");
    const u = await call(host(env, "tiktok") + "/v2/user/info/?fields=display_name", { headers: { Authorization: "Bearer " + t.data.access_token } });
    const name = (u.ok && u.data.data && u.data.data.user && u.data.data.user.display_name) || "TikTok account";
    return { accessToken: t.data.access_token, refreshToken: t.data.refresh_token, expiresAt: expiry(t.data.expires_in), accountId: t.data.open_id, accountName: name };
  }
  const s = await call(host(env, "ig_token") + "/oauth/access_token", { method: "POST", headers: FORM, body: form({ client_id: c.id, client_secret: c.secret, grant_type: "authorization_code", redirect_uri: redirectUri(env, p), code: code }) });
  const short = s.data && (Array.isArray(s.data.data) ? s.data.data[0] : s.data);
  if (!s.ok || !short || !short.access_token) failFrom("Instagram", s, "Instagram didn't finish connecting.");
  const l = await call(host(env, "ig_graph") + "/access_token?" + form({ grant_type: "ig_exchange_token", client_secret: c.secret, access_token: short.access_token }));
  if (!l.ok || !l.data.access_token) failFrom("Instagram", l, "Instagram didn't finish connecting.");
  const me = await call(host(env, "ig_graph") + "/" + IG_VERSION + "/me?" + form({ fields: "user_id,username", access_token: l.data.access_token }));
  if (!me.ok) failFrom("Instagram", me, "Couldn't read your Instagram account.");
  return { accessToken: l.data.access_token, refreshToken: null, expiresAt: expiry(l.data.expires_in), accountId: String(me.data.user_id || me.data.id), accountName: "@" + me.data.username };
}

export async function refresh(env, p, t0) {
  const c = creds(env, p);
  if (p === "youtube") {
    const t = await call(host(env, "google_token") + "/token", { method: "POST", headers: FORM, body: form({ client_id: c.id, client_secret: c.secret, refresh_token: t0.refreshToken, grant_type: "refresh_token" }) });
    if (!t.ok || !t.data.access_token) failFrom("YouTube", t, "YouTube sign-in expired.");
    return { accessToken: t.data.access_token, refreshToken: t.data.refresh_token || null, expiresAt: expiry(t.data.expires_in) };
  }
  if (p === "tiktok") {
    const t = await call(host(env, "tiktok") + "/v2/oauth/token/", { method: "POST", headers: FORM, body: form({ client_key: c.id, client_secret: c.secret, grant_type: "refresh_token", refresh_token: t0.refreshToken }) });
    if (!t.ok || !t.data.access_token) failFrom("TikTok", t, "TikTok sign-in expired.");
    return { accessToken: t.data.access_token, refreshToken: t.data.refresh_token || null, expiresAt: expiry(t.data.expires_in) };
  }
  const t = await call(host(env, "ig_graph") + "/refresh_access_token?" + form({ grant_type: "ig_refresh_token", access_token: t0.accessToken }));
  if (!t.ok || !t.data.access_token) failFrom("Instagram", t, "Instagram sign-in expired.");
  return { accessToken: t.data.access_token, refreshToken: null, expiresAt: expiry(t.data.expires_in) };
}

/* body() returns a fresh stream of the clip each time it's called. */
export async function publishYouTube(env, token, file, body, opts) {
  const title = (opts.caption || "Cutline clip").replace(/[<>]/g, "").slice(0, 100) || "Cutline clip";
  const meta = { snippet: { title: title, description: opts.caption || "", categoryId: "22" }, status: { privacyStatus: opts.privacy, selfDeclaredMadeForKids: false } };
  const start = await call(host(env, "youtube") + "/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(file.size), "X-Upload-Content-Type": file.mime }, body: JSON.stringify(meta) });
  if (!start.ok) failFrom("YouTube", start, "YouTube didn't accept the upload.");
  const location = start.headers.get("location");
  if (!location) throw new PlatformError("YouTube didn't return an upload address. Try again.");
  const up = await call(location, { method: "PUT", headers: { "Content-Type": file.mime, "Content-Length": String(file.size) }, body: body(), timeout: 10 * 60 * 1000 });
  if (!up.ok || !up.data.id) failFrom("YouTube", up, "YouTube couldn't finish the upload.");
  return { remoteId: up.data.id, url: "https://www.youtube.com/shorts/" + up.data.id };
}

function tiktokData(r, fallback) {
  const code = r.data && r.data.error && r.data.error.code;
  if (!r.ok || (code && code !== "ok")) {
    console.error("TikTok error " + r.status + ": " + JSON.stringify(r.data).slice(0, 500));
    const msg = r.data && r.data.error && r.data.error.message;
    throw new PlatformError(fallback + (msg ? " TikTok said: " + String(msg).slice(0, 160) : ""), { reconnect: code === "access_token_invalid" || r.status === 401 });
  }
  return (r.data && r.data.data) || {};
}
const ttHeaders = (token) => ({ Authorization: "Bearer " + token, "Content-Type": "application/json; charset=UTF-8" });
export async function tiktokCreator(env, token) {
  return tiktokData(await call(host(env, "tiktok") + "/v2/post/publish/creator_info/query/", { method: "POST", headers: ttHeaders(token), body: "{}" }), "TikTok couldn't load your account details.");
}
/* Starts a TikTok upload. TikTok then processes it; tiktokStatus checks on it later. Clips are capped under 64 MB, so one piece is enough. */
export async function startTikTok(env, token, file, body, o) {
  const init = tiktokData(await call(host(env, "tiktok") + "/v2/post/publish/video/init/", { method: "POST", headers: ttHeaders(token), body: JSON.stringify({
    post_info: { title: o.caption, privacy_level: o.privacy, disable_comment: !o.allowComment, disable_duet: !o.allowDuet, disable_stitch: !o.allowStitch, brand_content_toggle: Boolean(o.branded), brand_organic_toggle: Boolean(o.yourBrand) },
    source_info: { source: "FILE_UPLOAD", video_size: file.size, chunk_size: file.size, total_chunk_count: 1 }
  }) }), "TikTok didn't accept the upload.");
  const r = await call(init.upload_url, { method: "PUT", headers: { "Content-Type": file.mime, "Content-Length": String(file.size), "Content-Range": "bytes 0-" + (file.size - 1) + "/" + file.size }, body: body(), timeout: 10 * 60 * 1000 });
  if (!r.ok) failFrom("TikTok", r, "TikTok couldn't finish the upload.");
  return init.publish_id;
}
export async function tiktokStatus(env, token, publishId) {
  const s = tiktokData(await call(host(env, "tiktok") + "/v2/post/publish/status/fetch/", { method: "POST", headers: ttHeaders(token), body: JSON.stringify({ publish_id: publishId }) }), "TikTok couldn't check the upload.");
  if (s.status === "PUBLISH_COMPLETE") return { done: true, url: "" };
  if (s.status === "FAILED") throw new PlatformError("TikTok couldn't publish the clip" + (s.fail_reason ? " (" + s.fail_reason + ")" : "") + ".");
  return { done: false };
}

/* Instagram downloads the clip from a private link, processes it, then we publish it. */
export async function startInstagram(env, token, igId, mediaUrl, caption) {
  const c = await call(host(env, "ig_graph") + "/" + IG_VERSION + "/" + igId + "/media", { method: "POST", headers: FORM, body: form({ media_type: "REELS", video_url: mediaUrl, caption: caption || "", access_token: token }) });
  if (!c.ok || !c.data.id) failFrom("Instagram", c, "Instagram didn't accept the clip.");
  return c.data.id;
}
export async function instagramStatus(env, token, igId, containerId) {
  const g = host(env, "ig_graph") + "/" + IG_VERSION;
  const s = await call(g + "/" + containerId + "?" + form({ fields: "status_code,status", access_token: token }));
  if (!s.ok) failFrom("Instagram", s, "Instagram couldn't check the clip.");
  if (s.data.status_code === "ERROR" || s.data.status_code === "EXPIRED") throw new PlatformError("Instagram couldn't process the clip" + (s.data.status ? " (" + s.data.status + ")" : "") + ".");
  if (s.data.status_code !== "FINISHED") return { done: false };
  const pub = await call(g + "/" + igId + "/media_publish", { method: "POST", headers: FORM, body: form({ creation_id: containerId, access_token: token }) });
  if (!pub.ok || !pub.data.id) failFrom("Instagram", pub, "Instagram couldn't publish the clip.");
  const link = await call(g + "/" + pub.data.id + "?" + form({ fields: "permalink", access_token: token }));
  return { done: true, url: (link.ok && link.data.permalink) || "" };
}
