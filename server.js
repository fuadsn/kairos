import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDb, secretEqual } from './db.js';
import { send, status as smsStatus } from './sms.js';
import { placeCall, supplierVariables, simulate } from './sarvam.js';
import { layoutFor } from './thinker.js';

const root = dirname(fileURLToPath(import.meta.url));
// Intentionally small: KEY=value, optional matching quotes, full-line comments.
export function loadEnv(path = join(root, '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
// Voice-agent tools send flat strings; turn them into the typed fields the task operations expect.
export function coerce(input) {
  const out = { ...input }, blank = v => v == null || /^(|unknown|null|none|not stated)$/i.test(String(v).trim());
  for (const k of ['hardConstraints', 'preferences', 'unresolved', 'unknown']) if (typeof out[k] === 'string') out[k] = out[k].split(/[;\n]/).map(x => x.trim()).filter(x => x && !blank(x));
  for (const k of ['budgetMax', 'basePrice', 'fees', 'taxes', 'deposit', 'upfront', 'offerVersion', 'minutes']) if (k in out && typeof out[k] !== 'number') out[k] = blank(out[k]) || !/\d/.test(out[k]) ? null : Number(String(out[k]).replace(/[^\d.]/g, ''));
  for (const k of ['discloseBudget', 'mayCounter', 'accepted']) if (typeof out[k] === 'string') out[k] = /^(true|yes|1)$/i.test(out[k].trim());
  if (typeof out.contacts === 'string') out.contacts = out.contacts.split(/[;\n]/).map(c => { const phone = c.match(/\+?\d[\d\s-]{8,}\d/)?.[0]; return phone && { name: c.replace(phone, '').replace(/[,:|-]+\s*$/, '').trim() || 'Supplier', phone: phone.replace(/[\s-]/g, '').replace(/^(?:0|91)?(\d{10})$/, '+91$1') }; }).filter(Boolean);
  if (!out.existingArrangement && out.existingReference) out.existingArrangement = { reference: out.existingReference, acceptedTerms: out.existingTerms };
  if (typeof out.ownerPhone === 'string') out.ownerPhone = out.ownerPhone.replace(/[\s-]/g, '').replace(/^(?:0|91)?(\d{10})$/, '+91$1');
  return out;
}
function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
async function body(req, max = 128 * 1024) {
  if (Number(req.headers['content-length'] || 0) > max) fail('Request body is too large', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) fail('Request body is too large', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  try { const value = JSON.parse((await body(req)).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object'); return value; }
  catch (error) { if (error.status) throw error; fail('Invalid JSON'); }
}

export async function startServer(options = {}) {
  const config = { ...process.env, ...options.config };
  const dbPath = config.DB_PATH || join(root, 'kairos.db');
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = openDb(dbPath, config);
  const uploadsRoot = options.uploadsRoot || join(root, 'uploads');
  const html = readFileSync(join(root, 'public/task.html'));
  let busy = false, closing = false, timer;
  async function tick() {
    if (busy || closing) return;
    busy = true;
    let action, prepared;
    try {
      action = db.claim(); if (!action) return;
      if (action.type === 'notify') {
        const notification = db.notification(action.action_key);
        const result = await send(db.task(action.task_id).owner_phone, notification.body, action.action_key, config);
        db.notificationResult(action, result);
        if (result.status === 'handed_to_phone' && result.messageId) setTimeout(async () => {
          const m = await smsStatus(result.messageId, config), event = m.state === 'Failed' ? 'sms:failed' : m.state === 'Delivered' ? 'sms:delivered' : null;
          try { if (event) db.smsWebhook({ event, payload: { messageId: result.messageId, phoneNumber: m.phoneNumber, reason: m.reason } }); } catch { /* server closing or already recorded */ }
        }, Number(config.SMS_CHECK_MS ?? 4000)).unref();
      } else if (action.type === 'call') {
        prepared = db.prepareCall(action);
        if (prepared) {
          const variables = supplierVariables(prepared.task, prepared.participant, prepared.purpose, prepared);
          db.saveVariables(prepared.attemptId, variables);
          try { db.dispatched(prepared.attemptId, await placeCall({ ...prepared, variables, actionKey: action.action_key, actionId: action.id }, config)); }
          catch (error) { db.dispatchFailed(prepared.attemptId, error); }
        }
      } else if (action.type === 'simulate') {
        simulate(db, action.payload.attemptId);
        db.finishAction(action.id);
      }
    } catch (error) {
      if (action) {
        db.uncertainAction(action, error.message);
        console.error(`Action ${action.id} needs reconciliation: ${error.message}`);
        if (prepared) db.dispatchFailed(prepared.attemptId, Object.assign(error, { uncertain: true }));
      } else console.error('Worker:', error.message);
    } finally { busy = false; }
  }
  function respond(res, status, data, extra = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }); res.end(JSON.stringify(data));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      if (!['GET','POST'].includes(req.method)) return respond(res, 405, { error: 'Method not allowed' });
      // No CORS. Reject cross-origin browser mutations even when cookies are sent.
      if (req.method === 'POST' && req.headers.origin) {
        let origin; try { origin = new URL(req.headers.origin); } catch { fail('Invalid origin', 403); }
        if (origin.host !== host || req.headers['sec-fetch-site'] === 'cross-site') fail('Cross-origin mutation refused', 403);
      }
      let pageTaskId = url.pathname.match(/^\/t\/([a-f0-9]{32})$/)?.[1];
      const baseDomain = config.BASE_DOMAIN?.toLowerCase();
      const hostname = url.hostname.toLowerCase();
      if (baseDomain && hostname.endsWith(`.${baseDomain}`)) {
        const label = hostname.slice(0, -(baseDomain.length + 1));
        if (!label.includes('.') && url.pathname === '/') pageTaskId = db.bySubdomain(label);
      }
      if (req.method === 'GET' && pageTaskId) {
        db.task(pageTaskId);
        // The ID is an identifier, not an authentication secret; HTML is identical for every task.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        return res.end(html);
      }
      // Resolves a subdomain without exposing any private task data.
      if (req.method === 'GET' && url.pathname === '/api/task-id' && baseDomain && hostname.endsWith(`.${baseDomain}`)) {
        const taskId = db.bySubdomain(hostname.slice(0, -(baseDomain.length + 1)));
        if (!taskId) fail('Task not found', 404);
        return respond(res, 200, { taskId });
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kairos</title><body style="font:18px/1.5 system-ui;max-width:32rem;margin:15vh auto;padding:0 1.25rem;background:#f4f3ef;color:#1d2420"><h1>Kairos</h1><p>Call to get something arranged. Kairos makes the calls, compares the answers, and brings you the terms to approve.</p><p><strong>${config.SARVAM_AGENT_NUMBER || 'Number coming soon'}</strong></p>`);
      }
      const ownerRoute = url.pathname.match(/^\/api\/tasks\/([a-f0-9]{32})(?:\/(.+))?$/);
      if (ownerRoute) {
        const [, taskId, operation] = ownerRoute;
        if (req.method === 'POST' && operation === 'otp/request') return respond(res, 200, db.requestOtp(taskId));
        if (req.method === 'POST' && operation === 'otp/verify') {
          const result = db.verifyOtp(taskId, (await readJson(req)).code);
          if (result.error) return respond(res, result.status, { error: result.error });
          const secure = config.PUBLIC_URL?.startsWith('https:') ? '; Secure' : '';
          return respond(res, 200, { ok: true }, { 'Set-Cookie': `kairos_session=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}` });
        }
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('kairos_session='))?.slice(15);
        const row = db.task(taskId);
        if (Date.now() - Date.parse(row.created_at) > Number(config.TASK_TTL_HOURS || 24) * 3600e3) fail('This task link has expired.', 404); // purge runs each minute; this covers the gap
        // Open links by default (owner's decision for the demo); REQUIRE_OTP=1 restores phone verification.
        const owner = config.REQUIRE_OTP === '1' ? db.authenticate(taskId, cookie) : row.owner_phone;
        if (!owner) return respond(res, 401, { error: 'Verify your phone to open this private task.' });
        if (req.method === 'GET' && !operation) return respond(res, 200, db.view(taskId));
        if (req.method !== 'POST') fail('Route not found', 404);
        if (operation === 'stop') return respond(res, 200, db.stop(taskId));
        if (operation === 'upload') {
          const contentType = String(req.headers['content-type'] || '').split(';')[0];
          const extensions = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };
          if (!extensions[contentType]) fail('Only PDF, PNG and JPEG are allowed', 415);
          const raw = await body(req, 10 * 1024 * 1024);
          const signatures = { 'application/pdf': raw.subarray(0,5).toString() === '%PDF-', 'image/png': raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'image/jpeg': raw[0] === 255 && raw[1] === 216 && raw[2] === 255 };
          if (!raw.length || !signatures[contentType]) fail('File contents do not match the allowed type', 415);
          const dir = join(uploadsRoot, taskId); mkdirSync(dir, { recursive: true });
          const path = join(dir, randomBytes(16).toString('hex') + extensions[contentType]);
          const filename = String(req.headers['x-filename'] || `upload${extensions[contentType]}`).replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200);
          writeFileSync(path, raw, { flag: 'wx', mode: 0o600 });
          try { db.addUpload(taskId, { filename, path, contentType, size: raw.length }); } catch (error) { unlinkSync(path); throw error; }
          return respond(res, 201, { ok: true });
        }
        const input = await readJson(req);
        if (operation === 'answer') return respond(res, 200, db.answer(taskId, input));
        if (operation === 'revise') return respond(res, 200, db.revise(taskId, input.changes));
        if (operation === 'counter') return respond(res, 200, db.counter(taskId, input));
        if (operation === 'approve') return respond(res, 200, db.approve(taskId, input, owner));
        fail('Route not found', 404);
      }
      if (url.pathname.startsWith('/tools/')) {
        // Tools accept the bearer token, or a call from Sarvam's documented egress IPs as reported by the Cloudflare tunnel.
        // ponytail: any Sarvam customer shares these IPs; attach the bearer token to the tools in Sarvam and unset SARVAM_IPS after the demo.
        const fromSarvam = (config.SARVAM_IPS ?? '').split(',').map(x => x.trim()).filter(Boolean).includes(req.headers['cf-connecting-ip']);
        if (!fromSarvam && !secretEqual(req.headers.authorization, config.TOOL_TOKEN ? `Bearer ${config.TOOL_TOKEN}` : '')) fail('Tool authentication required', 401);
        if (req.method === 'GET' && url.pathname === '/tools/authority') return respond(res, 200, db.authority(url.searchParams.get('taskId'), url.searchParams.get('offerId'), Number(url.searchParams.get('offerVersion'))));
        if (req.method !== 'POST') fail('Route not found', 404);
        const input = coerce(await readJson(req));
        if (url.pathname === '/tools/draft') {
          const result = db.createDraft(input);
          db.setLayout(result.taskId, await layoutFor(db.task(result.taskId), config.THINKER));
          return respond(res, 201, result);
        }
        if (url.pathname === '/tools/confirm-brief') return respond(res, 200, db.confirmBrief(input.taskId));
        if (url.pathname === '/tools/callback') return respond(res, 200, db.callback(input));
        if (url.pathname === '/tools/question') return respond(res, 200, db.question(input));
        if (url.pathname === '/tools/offer') return respond(res, 200, db.offer(input));
        if (url.pathname === '/tools/acceptance') return respond(res, 200, db.acceptance(input));
        fail('Route not found', 404);
      }
      if (req.method === 'POST' && ['/webhooks/sarvam','/webhooks/sms'].includes(url.pathname)) {
        if (!secretEqual(url.searchParams.get('token'), config.WEBHOOK_SECRET)) fail('Webhook authentication required', 401);
        const input = await readJson(req);
        return respond(res, 200, url.pathname.endsWith('/sms') ? db.smsWebhook(input) : db.sarvamWebhook(input));
      }
      fail('Route not found', 404);
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) console.error('Request failed:', error.message);
      if (!res.headersSent) respond(res, status, { error: status === 500 ? 'The request could not be completed.' : error.message });
      else res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? Number(config.PORT || 3000), options.host || '127.0.0.1', resolve); });
  } catch (error) { db.close(); throw error; }
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  if (!config.PUBLIC_URL) config.PUBLIC_URL = url;
  db.recover();
  const purge = () => { for (const taskId of db.purgeExpired(Number(config.TASK_TTL_HOURS || 24))) rmSync(join(uploadsRoot, taskId), { recursive: true, force: true }); };
  purge(); const purgeTimer = setInterval(purge, 60_000); purgeTimer.unref();
  timer = setInterval(tick, options.workerInterval ?? 100);
  return { server, db, config, url, tick,
    async close() {
      closing = true; clearInterval(timer);
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      while (busy) await new Promise(resolve => setTimeout(resolve, 10));
      db.close();
    }
  };
}

export async function seed(app) {
  const deadline = new Date(Date.now() + 7 * 86400_000).toISOString();
  const { taskId } = app.db.createDraft({ ownerPhone: app.config.DEMO_OWNER_PHONE || '+910000000000', language: 'English', type: 'appointment', mode: 'arrangement', outcome: 'Print and deliver 100 flyers', hardConstraints: ['100 flyers'], preferences: [], deadline, timezone: 'Asia/Kolkata', budgetMax: 2500, discloseBudget: false, mayCounter: true, contacts: [{ name: 'Printer A (demo)', phone: '+910000000001' }, { name: 'Printer B (demo)', phone: '+910000000002' }], unresolved: [] });
  app.db.setLayout(taskId, await layoutFor(app.db.task(taskId), app.config.THINKER));
  app.db.confirmBrief(taskId);
  console.log(`Demo task: ${app.config.PUBLIC_URL.replace(/\/$/, '')}/t/${taskId}`);
  return taskId;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  try {
    if (process.argv.includes('--seed') && process.env.SARVAM_API_KEY) throw new Error('--seed uses fake suppliers and is available only with simulated calls (unset SARVAM_API_KEY).');
    const app = await startServer({ host: '0.0.0.0' });
    console.log(`Kairos listening at ${app.url}. Calls: ${app.config.SARVAM_API_KEY ? 'live' : 'SIMULATED'}. SMS: ${app.config.SMS_GATEWAY_URL ? 'gateway' : 'SIMULATED; codes appear here'}.`);
    if (!app.config.TOOL_TOKEN) console.log('TOOL_TOKEN is unset: intake/tool HTTP routes are disabled.');
    if (process.argv.includes('--seed')) await seed(app);
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
