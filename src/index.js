/* Cutline server. Serves the page, keeps accounts in D1, and handles Stripe checkout.
   Secrets to set in Cloudflare (Worker, Settings, Variables and Secrets):
   ADMIN_EMAIL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and for reset emails RESEND_API_KEY and EMAIL_FROM.
   For posting to YouTube, TikTok, and Instagram, see the list at the top of src/social.js. */
import PAGE from "./app.html";
import { makeCaptions } from "./captions.js";
import { creatorRequest, adminCreators, adminCreatorStatus } from "./creators.js";
import PRIVACY from "./privacy.html";
import TERMS from "./terms.html";
import { FAVICON_SVG, ICON_PNG_BASE64, OG_JPG_BASE64 } from "./assets.js";
import { socialPage, socialApi, runQueue, deleteUserData } from "./queue.js";

const PLAN_LIMITS = { free: 5, solo: 100, pro: 500 };
const COOKIE = "cl_session";
const SESSION_SECONDS = 30 * 86400;
const PBKDF2_ITERATIONS = 100000; // the most Workers allows
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(request, env, url, ctx);
      if (/^\/(connect|oauth|media)\//.test(url.pathname)) return (await socialPage(request, env, url, await currentUser(request, env))) || new Response("Not found", { status: 404 });
      if ((request.method === "GET" || request.method === "HEAD") && Object.hasOwn(STATIC_FILES, url.pathname)) return staticFile(url.pathname, request.method);
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) return await page(request, env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error(err && err.stack || err);
      if (url.pathname.startsWith("/api/")) return json({ ok: false, code: "server_error", message: "Something went wrong on our end. Try again in a minute." }, 500);
      return new Response("Something went wrong. Try again in a minute.", { status: 500 });
    }
  },
  /* Runs every minute (see wrangler.jsonc) to post queued clips when their time comes. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runQueue(env));
    ctx.waitUntil(backfillPayments(env).catch(function (e) { backfillChecked = false; console.error("payments backfill", e && e.message); }));
  }
};

/* ---------- Static pages and images ---------- */
function bytes(base64) { const bin = atob(base64); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const STATIC_FILES = {
  "/privacy.html": [() => PRIVACY, "text/html; charset=utf-8"],
  "/terms.html": [() => TERMS, "text/html; charset=utf-8"],
  "/favicon.svg": [() => FAVICON_SVG, "image/svg+xml"],
  "/apple-touch-icon.png": [() => bytes(ICON_PNG_BASE64), "image/png"],
  "/og.jpg": [() => bytes(OG_JPG_BASE64), "image/jpeg"],
  "/robots.txt": [() => "User-agent: *\nAllow: /\n", "text/plain; charset=utf-8"]
};
function staticFile(path, method) {
  const [body, type] = STATIC_FILES[path];
  return new Response(method === "HEAD" ? null : body(), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}

/* ---------- Page ---------- */
async function page(request, env) {
  const user = await currentUser(request, env);
  const pub = user ? publicUser(user, env) : null;
  let html = PAGE;
  if (!pub || pub.role !== "admin") html = html.replace(/<!--ADMIN-START-->[\s\S]*?<!--ADMIN-END-->/g, "");
  const boot = "<script>window.CUTLINE_SERVER=" + JSON.stringify({ user: pub }).replace(/</g, "\\u003c") + ";</script>";
  html = html.replace("<!--SERVER-MODE-->", boot);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin"
    }
  });
}

/* ---------- API ---------- */
async function api(request, env, url, ctx) {
  const path = url.pathname, method = request.method;
  if (path === "/api/stripe/webhook" && method === "POST") return stripeWebhook(request, env);
  if (method === "POST") {
    const origin = request.headers.get("Origin");
    if (!origin || origin !== url.origin) return json({ ok: false, code: "bad_origin", message: "That request wasn't allowed." }, 403);
  }
  const route = method + " " + path;
  /* Clip uploads are video, not JSON, so they skip the JSON reader. */
  const body = method === "POST" && route !== "POST /api/clips/file" && route !== "POST /api/captions" ? await readJson(request) : {};
  const user = await currentUser(request, env);

  switch (route) {
    case "POST /api/signup": return signup(env, body, url, ctx);
    case "POST /api/login": return login(env, body, url, ctx);
    case "POST /api/logout": return logout(request, env);
    case "POST /api/forgot": return forgot(env, body, url);
    case "POST /api/reset": return resetPassword(env, body);
  }
  if (!user) return json({ ok: false, code: "auth_required", message: "Log in to continue." }, 401);

  switch (route) {
    case "GET /api/me": return json({ ok: true, user: publicUser(user, env) });
    case "POST /api/captions": return makeCaptions(request, env, user);
    case "POST /api/creators": return creatorRequest(env, user, body);
    case "POST /api/clips/claim": return claimClip(env, user);
    case "POST /api/clips/release": return releaseClip(env, user, body);
    case "GET /api/import/file": return importSharedFile(request, url);
    case "POST /api/import": return json({ ok: false, message: "Importing from Twitch and similar sites isn't available yet. Upload the file or paste a YouTube or direct video link." });
    case "POST /api/import-clip": return json({ ok: false, message: "Making finished clips from YouTube links isn't available yet. Your cut is saved on this page." });
    case "POST /api/plans/checkout": return planCheckout(env, user, body, url);
    case "POST /api/coins/checkout": return coinCheckout(env, user, body, url);
    case "POST /api/billing/portal": return billingPortal(env, user, url);
  }
  const social = await socialApi(route, request, env, ctx, url, user, body);
  if (social) return social;
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(user, env)) return json({ ok: false, code: "forbidden", message: "Only the admin can do that." }, 403);
    if (route === "GET /api/admin/users") return adminList(env);
    if (route === "GET /api/admin/stripe") return stripeStatus(env, url);
    if (route === "GET /api/admin/creators") return adminCreators(env);
    if (route === "POST /api/admin/creators") return adminCreatorStatus(env, body);
    if (route === "POST /api/admin/stripe/link") return linkAllToStripe(env);
    if (method === "POST") return adminAction(env, user, path.slice("/api/admin/users/".length), body);
  }
  return json({ ok: false, code: "not_found", message: "That isn't available." }, 404);
}

/* ---------- Accounts ---------- */
async function signup(env, body, url, ctx) {
  const email = cleanEmail(body.email), password = String(body.password || "");
  if (!email) return json({ ok: false, message: "Enter a valid email address, like name@example.com." }, 400);
  if (password.length < 8 || password.length > 200) return json({ ok: false, message: "Use a password with at least 8 characters." }, 400);
  if (body.acceptedRights !== true) return json({ ok: false, message: "Confirm that you'll only upload videos you have permission to use." }, 400);
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ ok: false, message: "An account with this email already exists. Log in instead." }, 409);
  const id = crypto.randomUUID(), salt = randomHex(16), hash = await hashPassword(password, salt), now = new Date().toISOString();
  try {
    await env.DB.prepare("INSERT INTO users (id, email, pass_hash, pass_salt, accepted_rights, created_at, last_login) VALUES (?, ?, ?, ?, 1, ?, ?)").bind(id, email, hash, salt, now, now).run();
  } catch (e) {
    return json({ ok: false, message: "An account with this email already exists. Log in instead." }, 409);
  }
  linkStripeLater(env, ctx, { id: id, email: email, stripe_customer: null });
  return json({ ok: true }, 200, { "Set-Cookie": await newSession(env, id) });
}

async function login(env, body, url, ctx) {
  const email = cleanEmail(body.email), password = String(body.password || "");
  const bad = json({ ok: false, message: "That email or password is incorrect." }, 401);
  if (!email || !password) return bad;
  const since = Date.now() - 15 * 60 * 1000;
  const fails = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE email = ? AND at > ?").bind(email, since).first();
  if (fails && fails.n >= 10) return json({ ok: false, message: "Too many tries. Wait 15 minutes, or reset your password." }, 429);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  const hash = await hashPassword(password, user ? user.pass_salt : "no-user-salt");
  if (!user || !safeEqual(hash, user.pass_hash)) {
    await env.DB.prepare("INSERT INTO login_fails (email, at) VALUES (?, ?)").bind(email, Date.now()).run();
    return bad;
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_fails WHERE email = ? OR at < ?").bind(email, since),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(nowSec()),
    env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(new Date().toISOString(), user.id)
  ]);
  if (!user.stripe_customer) linkStripeLater(env, ctx, user);
  return json({ ok: true }, 200, { "Set-Cookie": await newSession(env, user.id) });
}

async function logout(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return json({ ok: true }, 200, { "Set-Cookie": COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
}

async function forgot(env, body, url) {
  const email = cleanEmail(body.email);
  if (!email) return json({ ok: false, message: "Enter a valid email address, like name@example.com." }, 400);
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return json({ ok: false, message: "Password reset emails aren't turned on yet. Contact Cutline support for help." });
  const done = json({ ok: true });
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?").bind(email).first();
  if (!user) return done;
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM resets WHERE user_id = ? AND expires_at > ?").bind(user.id, nowSec()).first();
  if (recent && recent.n >= 3) return done;
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), user.id, nowSec() + 3600).run();
  const link = url.origin + "/?reset=" + token;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM, to: [user.email], subject: "Reset your Cutline password",
      text: "Someone asked to reset the password for your Cutline account.\n\nOpen this link to choose a new password. It works for 1 hour.\n" + link + "\n\nIf you didn't ask for this, you can ignore this email.",
      html: "<p>Someone asked to reset the password for your Cutline account.</p><p><a href=\"" + link + "\">Choose a new password</a>. The link works for 1 hour.</p><p>If you didn't ask for this, you can ignore this email.</p>"
    })
  });
  if (!res.ok) { console.error("Resend failed", res.status, await res.text()); return json({ ok: false, message: "The reset email couldn't be sent. Try again in a few minutes." }); }
  return done;
}

async function resetPassword(env, body) {
  const token = String(body.token || ""), password = String(body.password || "");
  if (password.length < 8 || password.length > 200) return json({ ok: false, message: "Use a password with at least 8 characters." }, 400);
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, message: "That reset link isn't valid. Go back and request a new one." }, 400);
  const row = await env.DB.prepare("SELECT r.user_id, u.email FROM resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used = 0 AND r.expires_at > ?").bind(await sha256(token), nowSec()).first();
  if (!row) return json({ ok: false, message: "That reset link expired or was already used. Go back and request a new one." }, 400);
  const salt = randomHex(16), hash = await hashPassword(password, salt);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?").bind(hash, salt, row.user_id),
    env.DB.prepare("UPDATE resets SET used = 1 WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare("DELETE FROM login_fails WHERE email = ?").bind(row.email)
  ]);
  return json({ ok: true, email: row.email });
}

/* ---------- Shared files ----------
   Google Drive and Dropbox links stream through here so the editor can play and export them.
   Only those two hosts are allowed, and only for logged in accounts, so this can't be used as an open proxy. */
function sharedDownloadUrl(raw) {
  let u; try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "drive.google.com" || host === "docs.google.com") {
    const m = u.pathname.match(/\/d\/([\w-]{10,})/), id = m ? m[1] : u.searchParams.get("id");
    if (!id || !/^[\w-]{10,}$/.test(id)) return null;
    return { url: "https://drive.usercontent.google.com/download?id=" + id + "&export=download&confirm=t", name: "Google Drive" };
  }
  if (host === "dropbox.com" || host === "www.dropbox.com") {
    u.hostname = "www.dropbox.com"; u.searchParams.delete("raw"); u.searchParams.set("dl", "1");
    return { url: u.href, name: "Dropbox" };
  }
  if (host === "dl.dropboxusercontent.com") return { url: u.href, name: "Dropbox" };
  return null;
}

async function importSharedFile(request, url) {
  const src = sharedDownloadUrl(url.searchParams.get("url") || "");
  if (!src) return json({ ok: false, message: "Paste a Google Drive or Dropbox share link." }, 400);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; Cutline/1.0)" };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  let res;
  try { res = await fetch(src.url, { headers: headers, redirect: "follow" }); }
  catch (e) { return json({ ok: false, message: src.name + " didn't respond. Try again in a minute." }, 502); }
  const type = (res.headers.get("Content-Type") || "").toLowerCase();
  if (res.status === 404 || res.status === 403 || res.status === 401 || type.indexOf("text/html") > -1) {
    return json({ ok: false, message: "That " + src.name + " file isn't shared publicly. Set its sharing to anyone with the link, then try again." }, 400);
  }
  if (!res.ok && res.status !== 206) return json({ ok: false, message: src.name + " couldn't send that file. Try again in a minute." }, 502);
  if (type && type.indexOf("video/") !== 0 && type.indexOf("application/octet-stream") !== 0 && type.indexOf("binary/") !== 0) {
    return json({ ok: false, message: "That link isn't a video file. Share the video itself, not a folder or document." }, 400);
  }
  const out = new Headers({ "Content-Type": type.indexOf("video/") === 0 ? type : "video/mp4", "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  ["Content-Length", "Content-Range"].forEach(function (h) { const v = res.headers.get(h); if (v) out.set(h, v); });
  return new Response(res.body, { status: res.status, headers: out });
}

/* ---------- Clips ---------- */
/* Paid plans get their clips every 30 days, yearly plans included. */
const CYCLE_MS = 30 * 864e5;
async function refreshCycle(env, user) {
  if (user.plan === "free") return;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET plan_cycle_at = ? WHERE id = ? AND plan_cycle_at IS NULL").bind(now, user.id),
    env.DB.prepare("UPDATE users SET plan_used = 0, plan_cycle_at = ? WHERE id = ? AND plan_cycle_at < ?").bind(now, user.id, now - CYCLE_MS)
  ]);
}

async function claimClip(env, user) {
  let source = null;
  await refreshCycle(env, user);
  if (isAdmin(user, env)) source = "admin";
  else if (user.plan !== "free" && PLAN_LIMITS[user.plan] && await bump(env, "UPDATE users SET plan_used = plan_used + 1 WHERE id = ? AND plan_used < ?", user.id, PLAN_LIMITS[user.plan])) source = "plan";
  else if (user.plan === "free" && await bump(env, "UPDATE users SET free_used = free_used + 1 WHERE id = ? AND free_used < ?", user.id, PLAN_LIMITS.free)) source = "free";
  else if (await bump(env, "UPDATE users SET coins = coins - 1 WHERE id = ? AND coins > ?", user.id, 0)) source = "coin";
  const fresh = publicUser(await getUserById(env, user.id), env);
  if (!source) return json({ ok: false, code: "limit_reached", message: "You're out of clips.", clipsUsed: fresh.clipsUsed, coins: fresh.coins });
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO claims (id, user_id, source, created_at) VALUES (?, ?, ?, ?)").bind(id, user.id, source, new Date().toISOString()).run();
  return json({ ok: true, id: id, clipsUsed: fresh.clipsUsed, coins: fresh.coins });
}

async function releaseClip(env, user, body) {
  const id = String(body.id || "");
  const since = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ? AND user_id = ? AND released = 0 AND created_at > ?").bind(id, user.id, since).first();
  if (claim) {
    const undo = { plan: "UPDATE users SET plan_used = MAX(0, plan_used - 1) WHERE id = ?", free: "UPDATE users SET free_used = MAX(0, free_used - 1) WHERE id = ?", coin: "UPDATE users SET coins = coins + 1 WHERE id = ?" }[claim.source];
    const steps = [env.DB.prepare("UPDATE claims SET released = 1 WHERE id = ?").bind(id)];
    if (undo) steps.push(env.DB.prepare(undo).bind(user.id));
    await env.DB.batch(steps);
  }
  const fresh = publicUser(await getUserById(env, user.id), env);
  return json({ ok: true, clipsUsed: fresh.clipsUsed, coins: fresh.coins });
}

async function bump(env, sql, id, n) {
  const r = await env.DB.prepare(sql).bind(id, n).run();
  return r.meta && r.meta.changes > 0;
}

/* ---------- Admin ---------- */
async function adminList(env) {
  const { results } = await env.DB.prepare("SELECT id, email, plan, free_used, plan_used, coins, is_admin, stripe_customer, created_at, last_login FROM users ORDER BY created_at DESC LIMIT 5000").all();
  return json({ ok: true, users: results.map(function (u) {
    return { id: u.id, email: u.email, plan: u.plan, role: isAdmin(u, env) ? "admin" : "user", clipsUsed: u.plan === "free" ? u.free_used : u.plan_used, coins: u.coins, stripe: Boolean(u.stripe_customer), createdAt: u.created_at, lastLogin: u.last_login };
  }) });
}

async function adminAction(env, me, action, body) {
  const target = await getUserById(env, String(body.id || ""));
  if (!target) return json({ ok: false, message: "That account doesn't exist anymore." }, 404);
  if (isAdmin(target, env)) return json({ ok: false, message: "You can't change the admin account here." }, 400);
  if (action === "plan") {
    if (!PLAN_LIMITS.hasOwnProperty(body.plan)) return json({ ok: false, message: "Pick Free, Solo, or Pro." }, 400);
    await env.DB.prepare("UPDATE users SET plan = ? WHERE id = ?").bind(body.plan, target.id).run();
  } else if (action === "reset") {
    await env.DB.prepare("UPDATE users SET free_used = 0, plan_used = 0 WHERE id = ?").bind(target.id).run();
  } else if (action === "coins") {
    const amount = Math.trunc(Number(body.amount));
    if (!amount || Math.abs(amount) > 1000) return json({ ok: false, message: "Give between 1 and 1,000 coins." }, 400);
    await env.DB.prepare("UPDATE users SET coins = MAX(0, coins + ?) WHERE id = ?").bind(amount, target.id).run();
  } else if (action === "delete") {
    await deleteUserData(env, target.id);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM claims WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM resets WHERE user_id = ?").bind(target.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(target.id)
    ]);
  } else return json({ ok: false, message: "That isn't available." }, 404);
  return json({ ok: true });
}

/* ---------- Stripe ---------- */
/* One Product per plan and per coin pack. Prices are found by lookup key and created the first time
   they're needed, so the Stripe catalog stays clean and the Customer Portal can switch plans. */
const STRIPE_VERSION = "2026-10-28.endive";
const CATALOG = {
  cutline_solo_monthly: { name: "Cutline Solo", cents: 999, recurring: "month", plan: "solo" },
  cutline_pro_monthly: { name: "Cutline Pro", cents: 3999, recurring: "month", plan: "pro" },
  // Yearly prices live on the same product as the monthly one, as Stripe recommends for billing variants of one plan.
  cutline_solo_yearly: { name: "Cutline Solo", cents: 7999, recurring: "year", plan: "solo", sameProductAs: "cutline_solo_monthly" },
  cutline_pro_yearly: { name: "Cutline Pro", cents: 29999, recurring: "year", plan: "pro", sameProductAs: "cutline_pro_monthly" },
  cutline_coins_20: { name: "Cutline 20 coins", cents: 499, coins: 20, pack: "starter" },
  cutline_coins_50: { name: "Cutline 50 coins", cents: 799, coins: 50, pack: "creator" },
  cutline_coins_200: { name: "Cutline 200 coins", cents: 1999, coins: 200, pack: "studio" },
  // The old 10 coin pack, kept so refunds on earlier purchases still take the right number of coins back.
  cutline_coins_10: { name: "Cutline 10 coins", cents: 499, coins: 10, retired: true }
};
// Managed Payments makes Stripe the merchant of record, so it handles sales tax, VAT and GST, fraud and disputes.
// Every product needs a tax code that's eligible for it. This one is SaaS for business use.
const TAX_CODE = "txcd_10103001";
const PLAN_KEYS = { solo: { month: "cutline_solo_monthly", year: "cutline_solo_yearly" }, pro: { month: "cutline_pro_monthly", year: "cutline_pro_yearly" } };
const PACK_KEYS = { starter: "cutline_coins_20", creator: "cutline_coins_50", studio: "cutline_coins_200" };
const priceCache = {};

async function stripe(env, path, params, method) {
  method = method || "POST";
  const qs = method === "GET" && params ? "?" + formEncode(params) : "";
  const res = await fetch((env.STRIPE_API_BASE || "https://api.stripe.com") + "/v1/" + path + qs, {
    method: method,
    headers: { "Authorization": "Bearer " + env.STRIPE_SECRET_KEY, "Stripe-Version": STRIPE_VERSION, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? formEncode(params || {}) : undefined
  });
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.error && data.error.message || "Stripe error"); e.stripe = true; throw e; }
  return data;
}

async function priceFor(env, key) {
  if (priceCache[key]) return priceCache[key];
  const item = CATALOG[key];
  const found = await stripe(env, "prices", { lookup_keys: [key], active: "true", limit: 1 }, "GET");
  let price = found.data && found.data[0];
  if (!price || price.unit_amount !== item.cents || (item.recurring && (!price.recurring || price.recurring.interval !== item.recurring))) {
    // No price with this lookup key yet, or its amount is out of date. Reuse its product if there is one.
    let productId = price ? price.product : null;
    if (!productId && item.sameProductAs) {
      await priceFor(env, item.sameProductAs);
      const sib = await stripe(env, "prices", { lookup_keys: [item.sameProductAs], limit: 1 }, "GET");
      productId = sib.data && sib.data[0] ? sib.data[0].product : null;
    }
    if (!productId) productId = (await stripe(env, "products", { name: item.name, tax_code: TAX_CODE, metadata: { cutline_key: key } })).id;
    price = await stripe(env, "prices", Object.assign({ product: productId, currency: "usd", unit_amount: item.cents, lookup_key: key, transfer_lookup_key: "true" }, item.recurring ? { recurring: { interval: item.recurring } } : {}));
  }
  priceCache[key] = price.id;
  return price.id;
}

async function customerFor(env, user) {
  if (user.stripe_customer) return user.stripe_customer;
  const c = await stripe(env, "customers", { email: user.email, metadata: { user_id: user.id } }, "POST");
  await env.DB.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").bind(c.id, user.id).run();
  return c.id;
}

/* Every account gets a matching Stripe Customer as soon as it signs up (or next logs in), so purchases, receipts and
   the billing portal all line up with the Cutline account. It runs in the background and never blocks signup. */
function linkStripeLater(env, ctx, user) {
  if (!env.STRIPE_SECRET_KEY || !ctx || user.stripe_customer) return;
  ctx.waitUntil(customerFor(env, user).catch(function (e) { console.error("stripe link", user.email, e.message); }));
}

async function linkAllToStripe(env) {
  if (!env.STRIPE_SECRET_KEY) return json({ ok: false, message: "Add STRIPE_SECRET_KEY in Cloudflare first." });
  const { results } = await env.DB.prepare("SELECT id, email, stripe_customer FROM users WHERE stripe_customer IS NULL LIMIT 100").all();
  let linked = 0, failed = 0, lastError = "";
  for (const u of results) { try { await customerFor(env, u); linked++; } catch (e) { failed++; lastError = e.message; } }
  return json({ ok: failed === 0, linked: linked, failed: failed, message: failed ? "Linked " + linked + ", but " + failed + " failed: " + lastError : "Linked " + linked + (linked === 1 ? " account" : " accounts") + " to Stripe." });
}

async function stripeStatus(env, url) {
  const key = String(env.STRIPE_SECRET_KEY || "");
  const out = {
    ok: true, key: Boolean(key), restricted: key.indexOf("rk_") === 0,
    mode: /^(sk|rk)_live_/.test(key) ? "live" : /^(sk|rk)_test_/.test(key) ? "test" : key ? "unknown" : null,
    webhook: Boolean(env.STRIPE_WEBHOOK_SECRET), resend: Boolean(env.RESEND_API_KEY && env.EMAIL_FROM),
    webhookUrl: url.origin + "/api/stripe/webhook", reachable: false, reachError: ""
  };
  if (key) { try { await stripe(env, "customers", { limit: 1 }, "GET"); out.reachable = true; } catch (e) { out.reachError = e.message; } }
  const counts = await env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN stripe_customer IS NOT NULL THEN 1 ELSE 0 END) AS linked FROM users").first();
  const last = await env.DB.prepare("SELECT MAX(created_at) AS at FROM stripe_events").first();
  out.total = counts.total || 0; out.linked = counts.linked || 0; out.lastEvent = last && last.at || null;
  return json(out);
}

function integrationId() { let s = ""; const a = crypto.getRandomValues(new Uint8Array(8)); for (const b of a) s += String.fromCharCode(97 + b % 26); return "cutline-checkout-" + s; }
const notReady = () => json({ ok: false, message: "Checkout isn't set up yet, so this can't be purchased right now." });

async function planCheckout(env, user, body, url) {
  if (!env.STRIPE_SECRET_KEY) return notReady();
  const key = PLAN_KEYS[body.plan] && PLAN_KEYS[body.plan][body.interval === "year" ? "year" : "month"];
  if (!key) return json({ ok: false, message: "Pick Solo or Pro." }, 400);
  if (user.plan !== "free" && user.stripe_subscription) return billingPortal(env, user, url);
  try {
    const s = await stripe(env, "checkout/sessions", {
      mode: "subscription", customer: await customerFor(env, user), client_reference_id: user.id, allow_promotion_codes: "true",
      integration_identifier: integrationId(), managed_payments: { enabled: "true" },
      success_url: url.origin + "/?plan=success", cancel_url: url.origin + "/?plan=canceled",
      line_items: [{ price: await priceFor(env, key), quantity: 1 }],
      metadata: { user_id: user.id }, subscription_data: { metadata: { user_id: user.id } }
    });
    return json({ ok: true, url: s.url });
  } catch (e) { console.error("plan checkout", e.message); return json({ ok: false, message: "Checkout couldn't start. Try again in a minute." }); }
}

async function coinCheckout(env, user, body, url) {
  if (!env.STRIPE_SECRET_KEY) return notReady();
  const key = PACK_KEYS[body.pack];
  if (!key) return json({ ok: false, message: "Pick a coin pack." }, 400);
  try {
    const s = await stripe(env, "checkout/sessions", {
      mode: "payment", customer: await customerFor(env, user), client_reference_id: user.id,
      integration_identifier: integrationId(), managed_payments: { enabled: "true" },
      success_url: url.origin + "/?coins=success", cancel_url: url.origin + "/?coins=canceled",
      line_items: [{ price: await priceFor(env, key), quantity: 1 }],
      metadata: { user_id: user.id }
    });
    return json({ ok: true, url: s.url });
  } catch (e) { console.error("coin checkout", e.message); return json({ ok: false, message: "Checkout couldn't start. Try again in a minute." }); }
}

async function billingPortal(env, user, url) {
  if (!env.STRIPE_SECRET_KEY) return notReady();
  if (!user.stripe_customer) return json({ ok: false, message: "There's no billing account to manage yet." });
  try {
    const s = await stripe(env, "billing_portal/sessions", { customer: user.stripe_customer, return_url: url.origin + "/#pricing" });
    return json({ ok: true, url: s.url });
  } catch (e) { console.error("portal", e.message); return json({ ok: false, message: "The billing page couldn't open. Try again in a minute." }); }
}

async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Webhook secret not set", { status: 500 });
  const raw = await request.text();
  if (!await validSignature(raw, request.headers.get("Stripe-Signature") || "", env.STRIPE_WEBHOOK_SECRET)) return new Response("Bad signature", { status: 400 });
  const event = JSON.parse(raw);
  const first = await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, created_at) VALUES (?, ?)").bind(event.id, new Date().toISOString()).run();
  if (!first.meta || !first.meta.changes) return json({ received: true, duplicate: true });
  try {
    await handleEvent(env, event);
  } catch (e) {
    await env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    throw e;
  }
  return json({ received: true });
}

/* Events are matched to accounts through the Stripe Customer, which each account owns. Metadata is only a fallback. */
async function userForCustomer(env, customer, fallbackId) {
  let u = customer ? await env.DB.prepare("SELECT * FROM users WHERE stripe_customer = ?").bind(customer).first() : null;
  if (!u && fallbackId) {
    u = await getUserById(env, fallbackId);
    if (u && customer && !u.stripe_customer) await env.DB.prepare("UPDATE users SET stripe_customer = ? WHERE id = ?").bind(customer, u.id).run();
  }
  return u;
}

async function coinsInSession(env, sessionId) {
  const items = await stripe(env, "checkout/sessions/" + sessionId + "/line_items", { limit: 10 }, "GET");
  return items.data.reduce(function (n, li) { const c = CATALOG[li.price && li.price.lookup_key]; return n + (c && c.coins ? c.coins * (li.quantity || 1) : 0); }, 0);
}

async function fulfillCoins(env, session) {
  if (session.mode !== "payment" || session.payment_status === "unpaid") return;
  const user = await userForCustomer(env, session.customer, session.client_reference_id);
  if (!user) { console.error("no account for checkout", session.id); return; }
  const coins = await coinsInSession(env, session.id);
  if (coins > 0) await env.DB.prepare("UPDATE users SET coins = coins + ? WHERE id = ?").bind(coins, user.id).run();
  await recordPayment(env, session.id, user.id, "coins", session.amount_total, session.currency, coins + " coins", session.created);
}

/* Payments log: every charge and refund, so the admin sheet can show what each account has paid.
   Ids are Stripe's own (checkout session, invoice, or "refund_" + charge), so a repeat event never counts twice. */
async function recordPayment(env, id, userId, kind, cents, currency, note, createdSec) {
  if (!id || !userId || typeof cents !== "number") return;
  await env.DB.prepare("INSERT INTO payments (id, user_id, kind, amount_cents, currency, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET amount_cents = excluded.amount_cents, note = excluded.note")
    .bind(id, userId, kind, Math.round(cents), String(currency || "usd").toLowerCase(), note || "", new Date((createdSec ? createdSec * 1000 : Date.now())).toISOString()).run();
}

/* One-time fill of the payments log from Stripe for purchases made before it existed. Runs from the cron. */
let backfillChecked = false;
async function backfillPayments(env) {
  if (backfillChecked || !env.STRIPE_SECRET_KEY) return;
  backfillChecked = true;
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key = 'payments_backfilled'").first();
  if (done) return;
  let after = null;
  for (let page = 0; page < 20; page++) {
    const list = await stripe(env, "checkout/sessions", Object.assign({ limit: 100, status: "complete" }, after ? { starting_after: after } : {}), "GET");
    for (const s of list.data || []) {
      if (s.payment_status !== "paid" || !s.customer) continue;
      const user = await userForCustomer(env, s.customer, s.client_reference_id);
      if (!user) continue;
      if (s.mode === "payment") { let coins = 0; try { coins = await coinsInSession(env, s.id); } catch (e) {} await recordPayment(env, s.id, user.id, "coins", s.amount_total, s.currency, coins ? coins + " coins" : "Coins", s.created); }
      else if (s.mode === "subscription") await recordPayment(env, s.invoice || s.id, user.id, "plan", s.amount_total, s.currency, "Plan start", s.created);
    }
    if (!list.has_more || !list.data.length) break;
    after = list.data[list.data.length - 1].id;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('payments_backfilled', ?)").bind(new Date().toISOString()).run();
}

function intervalFromSubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const c = item && item.price && CATALOG[item.price.lookup_key];
  return (c && c.recurring) || (item && item.price && item.price.recurring && item.price.recurring.interval) || null;
}
function planFromSubscription(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  const c = item && item.price && CATALOG[item.price.lookup_key];
  return c && c.plan || null;
}

async function syncSubscription(env, sub) {
  const user = await userForCustomer(env, sub.customer, sub.metadata && sub.metadata.user_id);
  if (!user) { console.error("no account for subscription", sub.id); return; }
  const plan = planFromSubscription(sub);
  if (["active", "trialing", "past_due"].indexOf(sub.status) > -1 && plan) {
    await env.DB.prepare("UPDATE users SET plan = ?, stripe_subscription = ?, plan_used = CASE WHEN plan = 'free' THEN 0 ELSE plan_used END, plan_cycle_at = CASE WHEN plan = 'free' OR plan_cycle_at IS NULL THEN ? ELSE plan_cycle_at END, plan_interval = ?, plan_renews_at = ? WHERE id = ?").bind(plan, sub.id, Date.now(), intervalFromSubscription(sub), sub.cancel_at_period_end ? null : (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end) || sub.current_period_end || null, user.id).run();
  } else if (["canceled", "unpaid", "incomplete_expired"].indexOf(sub.status) > -1 && user.stripe_subscription === sub.id) {
    await env.DB.prepare("UPDATE users SET plan = 'free', stripe_subscription = NULL, plan_interval = NULL, plan_renews_at = NULL WHERE id = ?").bind(user.id).run();
  }
}

/* A refund or dispute on a coin pack takes those coins back. Plan refunds are handled by canceling in the Dashboard, which sends a subscription event. */
async function reverseCoins(env, paymentIntent, why) {
  if (!paymentIntent) return;
  const list = await stripe(env, "checkout/sessions", { payment_intent: paymentIntent, limit: 1 }, "GET");
  const session = list.data && list.data[0];
  if (!session || session.mode !== "payment") return;
  const user = await userForCustomer(env, session.customer, session.client_reference_id);
  const coins = await coinsInSession(env, session.id);
  if (user && coins > 0) {
    await env.DB.prepare("UPDATE users SET coins = MAX(0, coins - ?) WHERE id = ?").bind(coins, user.id).run();
    console.log("removed", coins, "coins from", user.email, "after", why);
  }
}

async function handleEvent(env, event) {
  const o = event.data && event.data.object || {};
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (o.mode === "payment") await fulfillCoins(env, o);
      else if (o.mode === "subscription" && o.subscription) await syncSubscription(env, await stripe(env, "subscriptions/" + o.subscription, null, "GET"));
      break;
    case "checkout.session.async_payment_failed":
      console.log("payment failed for checkout", o.id);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(env, o);
      break;
    case "invoice.paid":
      if (o.billing_reason === "subscription_cycle") await env.DB.prepare("UPDATE users SET plan_used = 0, plan_cycle_at = ? WHERE stripe_customer = ?").bind(Date.now(), o.customer).run();
      if (o.amount_paid > 0) {
        const payer = await userForCustomer(env, o.customer, null);
        if (payer) await recordPayment(env, o.id, payer.id, "plan", o.amount_paid, o.currency, o.billing_reason === "subscription_cycle" ? "Plan renewal" : o.billing_reason === "subscription_update" ? "Plan change" : "Plan start", o.created);
      }
      break;
    case "invoice.payment_failed":
      // Stripe retries the card and emails the customer. The plan stays on until the subscription ends.
      console.log("invoice payment failed for", o.customer);
      break;
    case "charge.refunded":
      if (o.refunded) await reverseCoins(env, o.payment_intent, "refund");
      if (o.amount_refunded > 0) {
        const refunded = await userForCustomer(env, o.customer, null);
        if (refunded) await recordPayment(env, "refund_" + o.id, refunded.id, "refund", -o.amount_refunded, o.currency, o.refunded ? "Full refund" : "Partial refund", Math.floor(Date.now() / 1000));
      }
      break;
    case "charge.dispute.created":
      await reverseCoins(env, o.payment_intent, "dispute");
      break;
    case "radar.early_fraud_warning.created":
      console.log("early fraud warning on charge", o.charge, "review it in the Stripe Dashboard");
      break;
  }
}

async function validSignature(payload, header, secret) {
  const parts = {}; let v1 = [];
  header.split(",").forEach(function (kv) { const i = kv.indexOf("="); const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); if (k === "v1") v1.push(v); else parts[k] = v; });
  const t = Number(parts.t);
  if (!t || !v1.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + payload)));
  return v1.some(function (sig) { return safeEqual(sig, expected); });
}

/* ---------- Helpers ---------- */
function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers || {}) });
}
async function readJson(request) { try { const d = await request.json(); return d && typeof d === "object" ? d : {}; } catch (e) { return {}; } }
function cleanEmail(v) { const e = String(v || "").trim().toLowerCase(); return e.length <= 254 && EMAIL_RE.test(e) ? e : ""; }
function isAdmin(user, env) { return Boolean(user && (user.is_admin === 1 || (env.ADMIN_EMAIL && user.email === String(env.ADMIN_EMAIL).trim().toLowerCase()))); }
function publicUser(u, env) {
  const admin = isAdmin(u, env), paid = u.plan !== "free";
  return { email: u.email, plan: u.plan, role: admin ? "admin" : "user", clipsUsed: paid ? (u.plan_cycle_at && u.plan_cycle_at < Date.now() - CYCLE_MS ? 0 : u.plan_used) : u.free_used, clipLimit: admin ? null : (PLAN_LIMITS[u.plan] || 5), coins: u.coins };
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function getUserById(env, id) { return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first(); }
async function currentUser(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  return env.DB.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?").bind(await sha256(token), nowSec()).first();
}
async function newSession(env, userId) {
  const token = randomHex(32);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), userId, nowSec() + SESSION_SECONDS).run();
  return COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + SESSION_SECONDS;
}
function readCookie(request, name) {
  const all = request.headers.get("Cookie") || "";
  for (const part of all.split(";")) { const i = part.indexOf("="); if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return "";
}
function hex(buf) { return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join(""); }
function randomHex(n) { return hex(crypto.getRandomValues(new Uint8Array(n))); }
async function sha256(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256));
}
function safeEqual(a, b) {
  a = String(a); b = String(b); let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function formEncode(obj) {
  const out = [];
  (function walk(v, key) {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach(function (x, i) { walk(x, key + "[" + i + "]"); });
    else if (typeof v === "object") Object.keys(v).forEach(function (k) { walk(v[k], key ? key + "[" + k + "]" : k); });
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  })(obj, "");
  return out.join("&");
}
