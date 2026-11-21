import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { startServer, coerce } from './server.js';
import { validateLayout, layoutFor, ruleAdvice, validateAdvice, research, advise, nextAction } from './thinker.js';

import { openDb, suitability, callingTime, indianPhone } from './db.js';
import { supplierVariables, flat, simulate } from './sarvam.js';

const TOOL_TOKEN = 'test-only-tool-token', WEBHOOK_SECRET = 'test-only-webhook-secret';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = overrides => ({ ownerPhone: '+910000000000', language: 'English', type: 'appointment', mode: 'arrangement', outcome: 'Print and deliver 100 flyers', hardConstraints: ['100 flyers'], preferences: [], deadline: '2030-12-01T12:00:00+05:30', timezone: 'Asia/Kolkata', budgetMax: 2500, discloseBudget: false, mayCounter: true, contacts: [{ name: 'Printer A', phone: '+910000000001' }, { name: 'Printer B', phone: '+910000000002' }], unresolved: [], ...overrides });
async function harness(t, config = {}, workerInterval = 2, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kairos-test-'));
  const options = { research: async () => [], advise: async view => ruleAdvice(view), ...overrides, port: 0, workerInterval, uploadsRoot: join(dir, 'uploads'), config: { DB_PATH: join(dir, 'test.db'), PORT: '0', PUBLIC_URL: '', TOOL_TOKEN, WEBHOOK_SECRET, SARVAM_API_KEY: '', SMS_GATEWAY_URL: '', THINKER: '', REQUIRE_OTP: '1', MAX_ATTEMPTS: '6', SIM_DELAY_MS: '0', ...config } };
  const h = { app: null, dir, options };
  try { h.app = await startServer(options); } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  t.after(async () => { await h.app.close(); rmSync(dir, { recursive: true, force: true }); });
  h.request = async (path, data, cookie, method = data === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(h.app.url + path, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(path.startsWith('/tools/') ? { Authorization: `Bearer ${TOOL_TOKEN}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const result = await response.json(); return { status: response.status, data: result, response };
  };
  h.ok = async (...args) => { const r = await h.request(...args); assert.ok(r.status < 300, `${args[0]}: ${r.status} ${JSON.stringify(r.data)}`); return r.data; };
  h.create = async input => (await h.ok('/tools/draft', brief(input))).taskId;
  h.login = async taskId => {
    await h.ok(`/api/tasks/${taskId}/otp/request`, {});
    const otp = h.app.db.sql.prepare("SELECT body FROM notifications WHERE task_id=? AND kind='otp' ORDER BY rowid DESC LIMIT 1").get(taskId).body.match(/\b\d{6}\b/)[0];
    const result = await h.request(`/api/tasks/${taskId}/otp/verify`, { code: otp }); assert.equal(result.status, 200);
    assert.match(result.response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
    return result.response.headers.get('set-cookie').split(';')[0];
  };
  h.view = (taskId, cookie) => h.ok(`/api/tasks/${taskId}`, undefined, cookie);
  h.wait = async (taskId, cookie, predicate) => {
    const end = Date.now() + 5000; let v;
    while (Date.now() < end) { v = await h.view(taskId, cookie); if (predicate(v)) return v; await sleep(10); }
    assert.fail(`Timed out: ${v?.task.state} ${JSON.stringify(v?.task.attempts)} ${JSON.stringify(v?.currentAction)}`);
  };
  h.ready = async input => {
    const taskId = await h.create(input), cookie = await h.login(taskId);
    await h.ok('/tools/confirm-brief', { taskId });
    let v = await h.wait(taskId, cookie, v => v.currentAction.type === 'question');
    assert.equal(v.currentAction.question.supplier, 'Printer A');
    await h.ok(`/api/tasks/${taskId}/answer`, { questionId: v.currentAction.question.id, answer: input?.type === 'reschedule' ? 'Tuesday at 10 am' : 'A5' }, cookie);
    v = await h.wait(taskId, cookie, v => (v.task.state === 'Needs you' && v.currentAction.type === 'approval' && v.offers.length === 2) || v.task.state === 'Completed');
    return { taskId, cookie, v };
  };
  h.attempt = (taskId, purpose) => h.app.db.sql.prepare(`SELECT * FROM call_attempts WHERE task_id=? ${purpose ? 'AND purpose=?' : ''} ORDER BY rowid DESC LIMIT 1`).get(...(purpose ? [taskId, purpose] : [taskId]));
  return h;
}

// These are real HTTP integration tests: no replacement of listening sockets or fetch.
test('flyer: question, resumed supplier, unsuitable delivery fee, counteroffer, exact approval, confirmation', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready();
  assert.equal(v.simulated, true); assert.ok(v.events.every(e => e.simulated));
  assert.equal(v.offers[0].total, 2300); assert.equal(v.offers[1].total, 2600);
  assert.equal(v.offers[1].suitable, false); assert.match(v.offers[1].reasons.join(' '), /exceeds.*2500/);
  assert.equal(v.questions[0].answer, 'A5');
  await h.ok(`/api/tasks/${taskId}/counter`, { offerId: v.offers[1].id }, cookie);
  const counter = await h.wait(taskId, cookie, v => v.task.state === 'Needs you' && v.offers.length === 3);
  const offer = counter.offers.find(o => o.supplier === 'Printer B' && o.validity === 'current');
  assert.equal(offer.version, 2); assert.equal(offer.total, 2200); assert.equal(offer.suitable, true);
  assert.equal(counter.offers.find(o => o.supplier === 'Printer B' && o.version === 1).validity, 'superseded');
  assert.equal((await h.request(`/api/tasks/${taskId}/counter`, { offerId: offer.id }, cookie)).status, 409);
  const input = { offerId: offer.id, offerVersion: offer.version };
  const first = await h.ok(`/api/tasks/${taskId}/approve`, input, cookie);
  const second = await h.ok(`/api/tasks/${taskId}/approve`, input, cookie);
  assert.equal(first.approvalId, second.approvalId);
  const done = await h.wait(taskId, cookie, v => v.task.state === 'Confirmed');
  assert.equal(done.outcome.offerVersion, 2); assert.equal(done.outcome.supplier, 'Printer B');
  assert.equal(h.app.db.sql.prepare('SELECT count(*) n FROM approvals WHERE task_id=?').get(taskId).n, 1);
  assert.equal(h.app.db.sql.prepare("SELECT count(*) n FROM call_attempts WHERE task_id=? AND purpose='confirm'").get(taskId).n, 1);
  assert.equal(done.task.attempts.length, 5);
  assert.equal(done.offers.find(o => o.version === 1 && o.supplier === 'Printer B').total, 2600);
  const variables = h.app.db.sql.prepare('SELECT variables FROM call_attempts WHERE task_id=?').all(taskId).map(a => JSON.parse(a.variables));
  assert.ok(variables.every(v => !Object.hasOwn(v, 'budgetMax')));
  assert.ok(variables.every(v => !JSON.stringify(v).includes('2500')));
  assert.deepEqual(variables[1].owner_answers, [{ text: v.questions[0].text, answer: 'A5' }]);
});

test('refresh and close/reopen preserve question, session, offers and queued work', async t => {
  const h = await harness(t), taskId = await h.create(), cookie = await h.login(taskId);
  await h.ok('/tools/confirm-brief', { taskId });
  const before = await h.wait(taskId, cookie, v => v.currentAction.type === 'question' && v.task.attempts[0].status === 'connected');
  await h.app.close(); h.app = await startServer(h.options);
  const after = await h.view(taskId, cookie);
  assert.deepEqual(after.questions, before.questions); assert.equal(after.task.state, 'Needs you');
  await h.ok(`/api/tasks/${taskId}/answer`, { questionId: after.questions[0].id, answer: 'A5' }, cookie);
  const ready = await h.wait(taskId, cookie, v => v.offers.length === 2 && v.task.state === 'Needs you');
  h.app.config.SIM_DELAY_MS = '100';
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: ready.offers[0].id, offerVersion: 1 }, cookie);
  await h.app.close(); h.app = await startServer(h.options);
  const done = await h.wait(taskId, cookie, v => v.task.state === 'Confirmed');
  assert.equal(done.outcome.offerId, ready.offers[0].id);
});

test('duplicate completion is a no-op and updates only its own attempt', async t => {
  const h = await harness(t), { taskId, cookie } = await h.ready();
  const attempt = h.attempt(taskId), before = await h.view(taskId, cookie);
  const payload = { attempt_id: attempt.provider_attempt_id, status: 'failed', failure_reason: 'stale duplicate' };
  const result = await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, payload);
  assert.equal(result.duplicate, true);
  const calls = v => v.events.filter(e => e.kind !== 'notification'); // SMS events land asynchronously
  assert.deepEqual(calls(await h.view(taskId, cookie)), calls(before));
  assert.equal(h.app.db.attempt(attempt.id).status, 'connected');
  assert.equal((await h.request('/webhooks/sarvam?token=wrong', payload)).status, 401);
});

test('changed offer invalidates approval; stale supplier acceptance becomes reconciliation evidence', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready();
  h.app.config.SIM_DELAY_MS = '100000';
  const offer = v.offers[0];
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: offer.id, offerVersion: 1 }, cookie);
  await h.wait(taskId, cookie, v => v.task.attempts.some(a => a.purpose === 'confirm'));
  const attempt = h.attempt(taskId, 'confirm');
  const changed = await h.ok('/tools/offer', { taskId, attemptId: attempt.id, ...offer.terms, basePrice: 2400 });
  assert.equal(changed.offerVersion, 2);
  assert.equal((await h.ok(`/tools/authority?taskId=${taskId}&offerId=${offer.id}&offerVersion=1`)).ok, false);
  assert.equal(h.app.db.sql.prepare('SELECT valid FROM approvals WHERE task_id=?').get(taskId).valid, 0);
  assert.notEqual((await h.view(taskId, cookie)).task.state, 'Confirmed');
  await h.ok('/tools/acceptance', { taskId, attemptId: attempt.id, offerId: offer.id, offerVersion: 1, accepted: true, conditions: [] });
  const final = await h.view(taskId, cookie);
  assert.equal(final.task.state, 'Needs reconciliation'); assert.ok(final.events.some(e => e.kind === 'supplier_response'));
});

test('stop during confirmation revokes authority and late acceptance is never silently discarded', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready(); h.app.config.SIM_DELAY_MS = '100000';
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: v.offers[0].id, offerVersion: 1 }, cookie);
  await h.wait(taskId, cookie, v => v.task.attempts.some(a => a.purpose === 'confirm'));
  const attempt = h.attempt(taskId, 'confirm');
  await h.ok(`/api/tasks/${taskId}/stop`, {}, cookie);
  assert.equal((await h.ok(`/tools/authority?taskId=${taskId}&offerId=${v.offers[0].id}&offerVersion=1`)).ok, false);
  const acceptance = { taskId, attemptId: attempt.id, offerId: v.offers[0].id, offerVersion: 1, accepted: true, conditions: [] };
  await h.ok('/tools/acceptance', acceptance);
  assert.equal((await h.ok('/tools/acceptance', acceptance)).duplicate, true);
  const final = await h.view(taskId, cookie); assert.equal(final.task.state, 'Needs reconciliation'); assert.equal(final.task.stopped, true);
});

test('revision marks offers for recheck, invalidates approval and preserves late acceptance evidence', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready(); h.app.config.SIM_DELAY_MS = '100000';
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: v.offers[0].id, offerVersion: 1 }, cookie);
  await h.wait(taskId, cookie, v => v.task.attempts.some(a => a.purpose === 'confirm'));
  const attempt = h.attempt(taskId, 'confirm');
  await h.ok(`/api/tasks/${taskId}/revise`, { changes: { outcome: 'Print and deliver 200 flyers', hardConstraints: ['200 flyers'] } }, cookie);
  const changed = await h.view(taskId, cookie); assert.equal(changed.task.revision, 2); assert.ok(changed.offers.every(o => o.validity === 'recheck'));
  assert.equal(h.app.db.sql.prepare('SELECT valid FROM approvals WHERE task_id=?').get(taskId).valid, 0);
  await h.ok('/tools/acceptance', { taskId, attemptId: attempt.id, offerId: v.offers[0].id, offerVersion: 1, accepted: true, conditions: [] });
  assert.equal((await h.view(taskId, cookie)).task.state, 'Needs reconciliation');
});

test('quote-only completes without approval or commitment', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready({ type: 'quote', mode: 'information' });
  assert.equal(v.task.state, 'Completed'); assert.match(v.outcome.text, /No booking/);
  assert.equal(h.app.db.sql.prepare('SELECT count(*) n FROM approvals WHERE task_id=?').get(taskId).n, 0);
  assert.equal((await h.request(`/api/tasks/${taskId}/approve`, { offerId: v.offers[0].id, offerVersion: 1 }, cookie)).status, 409);
});

test('reschedule retains original arrangement until explicit counterparty acceptance', async t => {
  const existingArrangement = { reference: 'PICKUP-DEMO', acceptedTerms: { day: 'Monday', time: '09:00' } };
  const h = await harness(t), { taskId, cookie, v } = await h.ready({ type: 'reschedule', outcome: 'Move the pickup to Tuesday', hardConstraints: ['Tuesday'], existingArrangement });
  assert.equal(v.task.existingArrangement.inForce, true); assert.deepEqual(v.task.existingArrangement.acceptedTerms, existingArrangement.acceptedTerms);
  assert.ok(v.layout.some(b => b.type === 'arrangement'));
  h.app.config.SIM_DELAY_MS = '100';
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: v.offers[0].id, offerVersion: 1 }, cookie);
  assert.equal((await h.view(taskId, cookie)).task.existingArrangement.inForce, true);
  const done = await h.wait(taskId, cookie, v => v.task.state === 'Confirmed');
  assert.equal(done.task.existingArrangement.inForce, false); assert.equal(done.task.existingArrangement.amendmentStatus, 'accepted');
  assert.deepEqual(done.task.existingArrangement.acceptedTerms, existingArrangement.acceptedTerms);
});

test('appointment script runs and a mandatory unpaid deposit prevents unconditional confirmation', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready({ outcome: 'Book a technician appointment', hardConstraints: [] });
  const prior = v.offers[0];
  const revised = await h.ok('/tools/offer', { taskId, attemptId: prior.attempt_id, ...prior.terms, deposit: 200, upfront: 200 });
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: prior.id, offerVersion: revised.offerVersion }, cookie);
  const done = await h.wait(taskId, cookie, v => v.task.state === 'Awaiting required action');
  assert.match(done.outcome.prerequisites.join(' '), /mandatory deposit/); assert.match(done.outcome.responsiblePerson, /Owner/);
});

test('owner authentication, five-attempt OTP rate limit, origin checks and private HTML', async t => {
  const h = await harness(t), taskId = await h.create(), other = await h.create({ ownerPhone: '+910000000099' });
  const otherCookie = await h.login(other);
  for (const cookie of [undefined, otherCookie]) {
    assert.equal((await h.request(`/api/tasks/${taskId}`, undefined, cookie)).status, 401);
    assert.equal((await h.request(`/api/tasks/${taskId}/stop`, {}, cookie)).status, 401);
  }
  const html = await fetch(h.app.url + `/t/${taskId}`);
  assert.match(html.headers.get('x-robots-tag'), /noindex/); assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  const source = await html.text(); assert.ok(!source.includes('Print and deliver 100 flyers')); assert.ok(!source.includes('+910000000000')); assert.ok(!source.includes('innerHTML'));
  await h.ok(`/api/tasks/${taskId}/otp/request`, {});
  for (let i = 0; i < 5; i++) assert.equal((await h.request(`/api/tasks/${taskId}/otp/verify`, { code: 'wrong' })).status, 401);
  assert.equal((await h.request(`/api/tasks/${taskId}/otp/verify`, { code: 'wrong' })).status, 429);
  assert.equal((await h.request(`/api/tasks/${taskId}/otp/request`, {})).status, 429);
  assert.equal((await h.request(`/api/tasks/${other}/stop`, {}, otherCookie, 'POST', { Origin: 'https://untrusted.invalid' })).status, 403);
});

test('attempt cap blocks with an explanation of what would unblock progress', async t => {
  const h = await harness(t, { MAX_ATTEMPTS: '1' });
  const taskId = await h.create(), cookie = await h.login(taskId); await h.ok('/tools/confirm-brief', { taskId });
  const v = await h.wait(taskId, cookie, v => v.currentAction.type === 'question');
  await h.ok(`/api/tasks/${taskId}/answer`, { questionId: v.questions[0].id, answer: 'A5' }, cookie);
  const final = await h.wait(taskId, cookie, v => v.task.state === 'Blocked');
  assert.match(final.task.blocked_reason, /limit.*exhausted.*new task/i); assert.equal(final.task.attempts.length, 1);
});

test('SMS failure leaves task intact; exact gateway payload and delivery callback truthfulness', async t => {
  let failSms = true, sent, messageNumber = 0;
  const gateway = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    sent = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(failSms ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `fake-message-${++messageNumber}`, arbitraryProviderField: 'kept' }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { gateway.close(resolve); gateway.closeIdleConnections(); }); });
  const h = await harness(t, { SMS_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}`, SMS_GATEWAY_USER: 'test-user', SMS_GATEWAY_PASS: 'test-pass' });
  const taskId = await h.create(); await h.ok('/tools/confirm-brief', { taskId });
  for (let i = 0; i < 100 && h.app.db.view(taskId).task.notifications[0]?.status !== 'failed'; i++) await sleep(10);
  assert.equal(h.app.db.view(taskId).task.notifications[0].status, 'failed'); assert.equal(h.app.db.task(taskId).id, taskId);
  assert.equal(sent.url, '/message'); assert.equal(sent.authorization, `Basic ${Buffer.from('test-user:test-pass').toString('base64')}`);
  assert.deepEqual(Object.keys(sent.body).sort(), ['phoneNumbers','textMessage','withDeliveryReport']); assert.deepEqual(sent.body.phoneNumbers, ['+910000000000']); assert.equal(sent.body.withDeliveryReport, true);
  failSms = false;
  const other = await h.create({ ownerPhone: '+910000000099' }); await h.ok('/tools/confirm-brief', { taskId: other });
  for (let i = 0; i < 100 && h.app.db.view(other).task.notifications[0]?.status !== 'handed_to_phone'; i++) await sleep(10);
  assert.equal(h.app.db.view(other).task.notifications[0].status, 'handed_to_phone');
  const messageId = h.app.db.view(other).task.notifications[0].provider_id;
  await h.ok(`/webhooks/sms?token=${WEBHOOK_SECRET}`, { event: 'sms:delivered', payload: { messageId, phoneNumber: '+910000000099' } });
  assert.equal(h.app.db.view(other).task.notifications[0].status, 'delivered');
});

test('unknown dispatch on restart stays uncertain and is never blindly dispatched again', async t => {
  const h = await harness(t, {}, 100000);
  const taskId = await h.create(); h.app.db.confirmBrief(taskId);
  let action = h.app.db.claim(); assert.equal(action.type, 'notify'); h.app.db.finishAction(action.id);
  action = h.app.db.claim(); const prepared = h.app.db.prepareCall(action); assert.ok(prepared);
  await h.app.close(); h.app = await startServer(h.options);
  assert.equal(h.app.db.sql.prepare('SELECT status FROM actions WHERE id=?').get(action.id).status, 'uncertain');
  assert.equal(h.app.db.attempt(prepared.attemptId).status, 'uncertain'); assert.equal(h.app.db.task(taskId).state, 'Blocked');
  await h.app.tick(); assert.equal(h.app.db.sql.prepare('SELECT count(*) n FROM call_attempts WHERE task_id=?').get(taskId).n, 1);
  // A later callback can correlate the unknown request using metadata.
  const p = prepared.participant;
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: 'recovered-provider-id', status: 'failed', webhook_config: { metadata: { taskId, actionId: String(action.id), participantId: p.id } } });
  assert.equal(h.app.db.attempt(prepared.attemptId).status, 'failed');
});

test('unknown charges stay unknown, permissions gate intake, constraints and append-only records are enforced', async t => {
  const h = await harness(t);
  const unresolved = await h.create({ unresolved: ['quantity'] }); assert.equal((await h.request('/tools/confirm-brief', { taskId: unresolved })).status, 409);
  const empty = await h.create({ contacts: [] }); assert.equal((await h.request('/tools/confirm-brief', { taskId: empty })).status, 409);
  const { taskId, cookie, v } = await h.ready(); const offer = v.offers[0];
  await h.ok('/tools/offer', { taskId, attemptId: offer.attempt_id, spec: '50 flyers', availability: 'Available', basePrice: 1000, deadline: '2031-01-01T00:00:00Z' });
  const changed = (await h.view(taskId, cookie)).offers.find(o => o.id === offer.id && o.version === 2);
  assert.equal(changed.total, null); assert.equal(changed.terms.fees, null); assert.equal(changed.terms.taxes, null);
  assert.match(changed.reasons.join(' '), /cannot confirm within budget/); assert.match(changed.reasons.join(' '), /misses/); assert.match(changed.reasons.join(' '), /100 flyers/);
  assert.equal((await h.request(`/api/tasks/${taskId}/approve`, { offerId: changed.id, offerVersion: 2 }, cookie)).status, 409);
  assert.throws(() => h.app.db.sql.prepare('UPDATE events SET text=? WHERE task_id=?').run('tampered', taskId), /append-only/);
  assert.throws(() => h.app.db.sql.prepare('DELETE FROM events WHERE task_id=?').run(taskId), /append-only/);
  const action = h.app.db.sql.prepare('SELECT * FROM actions WHERE task_id=? LIMIT 1').get(taskId);
  assert.throws(() => h.app.db.sql.prepare('INSERT INTO actions(task_id,task_revision,type,action_key,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(taskId,1,'call',action.action_key,'{}','x','x'), /UNIQUE/);
});

test('uploads require owner auth, validate MIME and size, and store random filenames', async t => {
  const h = await harness(t), taskId = await h.create(), cookie = await h.login(taskId);
  const data = Buffer.from('%PDF-1.4\nprototype test\n%%EOF');
  const path = `${h.app.url}/api/tasks/${taskId}/upload`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/pdf', 'X-Filename': '../../artwork.pdf' };
  assert.equal((await fetch(path, { method: 'POST', headers, body: data })).status, 201);
  const row = h.app.db.sql.prepare('SELECT * FROM uploads WHERE task_id=?').get(taskId);
  assert.match(row.path, /[a-f0-9]{32}\.pdf$/); assert.deepEqual(readFileSync(row.path), data);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/html' }, body: data })).status, 415);
  assert.equal((await fetch(path, { method: 'POST', headers, body: 'not a pdf' })).status, 415);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Cookie: '' }, body: data })).status, 401);
  assert.equal((await fetch(path, { method: 'POST', headers, body: Buffer.alloc(10 * 1024 * 1024 + 1) })).status, 413);
});

test('subdomain resolves same private page and fixed layouts reject untrusted block types', async t => {
  const h = await harness(t, { BASE_DOMAIN: 'demo.invalid' }), taskId = await h.create();
  const host = `${h.app.db.task(taskId).subdomain}.demo.invalid`;
  const result = await new Promise((resolve, reject) => {
    http.get(h.app.url + '/', { headers: { Host: host } }, res => { const parts = []; res.on('data', p => parts.push(p)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() })); }).on('error', reject);
  });
  assert.equal(result.status, 200); assert.ok(!result.body.includes('+910000000000'));
  const layout = await layoutFor(brief()); assert.deepEqual(validateLayout(layout), layout);
  assert.throws(() => validateLayout([{ type: 'script', props: { html: '<script>' } }]));
  assert.throws(() => validateLayout([...layout, { type: 'upload', props: { onClick: 'evil' } }]));
});

test('open links by default; expired task links stop resolving', async t => {
  const h = await harness(t, { REQUIRE_OTP: '' }), taskId = await h.create();
  assert.equal((await h.request(`/api/tasks/${taskId}`)).status, 200);
  h.app.db.sql.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', taskId);
  assert.equal((await h.request(`/api/tasks/${taskId}`)).status, 404);
  await h.app.close(); h.app = await startServer(h.options); // purge runs at boot
  for (const table of ['tasks', 'events', 'participants', 'notifications']) assert.equal(h.app.db.sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
});

test('flat voice-tool strings are coerced into typed fields; unknown charges stay null', () => {
  const d = coerce({ ownerPhone: '98765 43210', hardConstraints: '100 flyers; A5', budgetMax: '2,500', mayCounter: 'yes', discloseBudget: 'false', contacts: 'Printer A, 09876543210; Printer B: +91 98765 43211' });
  assert.deepEqual([d.ownerPhone, d.hardConstraints, d.budgetMax, d.mayCounter, d.discloseBudget], ['+919876543210', ['100 flyers', 'A5'], 2500, true, false]);
  assert.deepEqual(d.contacts, [{ name: 'Printer A', phone: '+919876543210' }, { name: 'Printer B', phone: '+919876543211' }]);
  const o = coerce({ basePrice: 'Rs 2200', fees: 'unknown', taxes: '', offerVersion: '2', accepted: 'true', conditions: '5000 upfront; none' });
  assert.deepEqual(o.conditions, ['5000 upfront']);
  assert.deepEqual([o.basePrice, o.fees, o.taxes, o.offerVersion, o.accepted], [2200, null, null, 2, true]);
});

test('tools accept an allow-listed Sarvam IP in place of the bearer token, and nothing else', async t => {
  const h = await harness(t, { SARVAM_IPS: '4.213.167.70' });
  const call = ip => fetch(h.app.url + '/tools/confirm-brief', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: '{}' }).then(r => r.status);
  assert.equal(await call(), 401); assert.equal(await call('1.2.3.4'), 401); assert.notEqual(await call('4.213.167.70'), 401);
});

test('supplier asks to be called later: a re-call is scheduled instead of blocking', async t => {
  const h = await harness(t, { SIM_DELAY_MS: '600000' }), taskId = await h.create({ contacts: [{ name: 'Printer A', phone: '+910000000001' }] });
  await h.ok('/tools/confirm-brief', { taskId });
  let attempt; for (let i = 0; i < 200 && !(attempt = h.app.db.sql.prepare('SELECT * FROM call_attempts WHERE task_id=? AND provider_attempt_id IS NOT NULL').get(taskId)); i++) await sleep(10);
  const r = await h.ok('/tools/callback', { taskId, attemptId: attempt.id, when: 'after lunch', minutes: '30' });
  assert.ok(Date.parse(r.callbackAt) > Date.now() + 29 * 60_000);
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: attempt.provider_attempt_id, status: 'connected' });
  const queued = h.app.db.sql.prepare("SELECT * FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId);
  assert.ok(queued && queued.due_at > Date.now() + 29 * 60_000, 'callback call queued for later');
  assert.equal(h.app.db.task(taskId).state, 'Working');
});

test('no answer schedules one automatic retry; owner can ask to call again after a block', async t => {
  const h = await harness(t, { SIM_DELAY_MS: '600000', RETRY_MINUTES: '5' }), taskId = await h.create({ contacts: [{ name: 'Printer A', phone: '+910000000001' }] });
  await h.ok('/tools/confirm-brief', { taskId });
  const dispatched = async n => { let rows; for (let i = 0; i < 300 && (rows = h.app.db.sql.prepare('SELECT * FROM call_attempts WHERE task_id=? AND provider_attempt_id IS NOT NULL ORDER BY created_at').all(taskId)).length < n; i++) await sleep(10); return rows[n - 1]; };
  const first = await dispatched(1);
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: first.provider_attempt_id, status: 'no_answer' });
  const q = h.app.db.sql.prepare("SELECT * FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId);
  assert.ok(q.due_at > Date.now() + 4 * 60_000); assert.equal(h.app.db.task(taskId).state, 'Working');
  h.app.db.sql.prepare('UPDATE actions SET due_at=0 WHERE id=?').run(q.id);
  const second = await dispatched(2);
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: second.provider_attempt_id, status: 'no_answer' });
  assert.equal(h.app.db.task(taskId).state, 'Blocked');
  const cookie = await h.login(taskId);
  assert.deepEqual(await h.ok(`/api/tasks/${taskId}/retry`, {}, cookie), { retried: 1 });
  assert.ok(await dispatched(3)); assert.equal(h.app.db.task(taskId).state, 'Working');
});

const candidates = [
  { name: 'Aroma Bakes', phone: '0484 2345678', sourceUrl: 'https://example.test/aroma', note: 'Custom cakes' },
  { name: 'Duplicate', phone: '+91 484 234 5678', sourceUrl: 'https://example.test/duplicate', note: 'Same number' },
  { name: 'Invalid', phone: '12345', sourceUrl: 'https://example.test/invalid', note: 'Invalid number' }
];
const quote = { spec: '100 flyers', availability: 'Available', deadline: brief().deadline, basePrice: 2000, fees: 0, taxes: 0, deposit: 0, upfront: 0, conditions: [], unknown: [] };
const adviceFor = view => ({ recommendOfferId: view.offers.find(o => o.suitable && o.validity === 'current')?.id || null, counterOfferId: null, counterAsk: null, summary: 'Review the exact scope and timing before approving.' });

test('discovery: optional contacts, valid unique candidates, explicit permission, sequential calls and one initial SMS', async t => {
  const h = await harness(t, { RESEARCH_CALL_HOURS: '00:00-00:00', SIM_DELAY_MS: '600000' }, 2, { research: async () => candidates });
  const taskId = await h.create({ contacts: undefined, supplierKind: 'custom cake bakery', location: 'Kakkanad, Kochi' }), cookie = await h.login(taskId);
  assert.deepEqual(await h.ok('/tools/confirm-brief', { taskId }), { taskId, state: 'Needs you', research: true });
  await h.ok('/tools/confirm-brief', { taskId });
  const v = await h.wait(taskId, cookie, v => v.events.some(e => e.kind === 'research'));
  assert.equal(v.contacts.length, 1); assert.equal(v.contacts[0].permitted, 0); assert.equal(v.contacts[0].phone, '••••5678');
  assert.equal(v.task.state, 'Needs you'); assert.ok(v.layout.some(b => b.type === 'suppliers'));
  assert.equal((await h.request(`/api/tasks/${taskId}/contacts`, { permit: [], add: [] }, cookie)).status, 409);
  await h.ok(`/api/tasks/${taskId}/contacts`, { permit: [v.contacts[0].id], add: [{ name: 'Owner bakery', phone: '9876543210' }] }, cookie);
  await h.wait(taskId, cookie, v => v.task.attempts.length === 1);
  const first = h.attempt(taskId); assert.equal(h.app.db.participant(first.participant_id).name, 'Aroma Bakes');
  await h.ok('/tools/offer', { taskId, attemptId: first.id, ...quote });
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: first.provider_attempt_id, status: 'connected' });
  const both = await h.wait(taskId, cookie, v => v.task.attempts.length === 2);
  assert.deepEqual(both.task.attempts.map(a => a.supplier), ['Aroma Bakes', 'Owner bakery']);
  assert.ok(both.events.some(e => e.kind === 'contact_permission' && /Aroma Bakes, Owner bakery/.test(e.text)));
  assert.equal(h.app.db.sql.prepare("SELECT count(*) n FROM notifications WHERE task_id=? AND action_key=?").get(taskId, `${taskId}:initial`).n, 1);
});

test('calling hours defer research, allow owner contacts immediately, and exempt allow-listed numbers', async t => {
  // Pick a one-minute window twelve hours away so this does not depend on wall-clock time.
  const local = new Date(Date.now() + 330 * 60_000), hour = (local.getUTCHours() + 12) % 24;
  const window = `${String(hour).padStart(2,'0')}:00-${String(hour).padStart(2,'0')}:01`;
  const h = await harness(t, { RESEARCH_CALL_HOURS: window, SIM_DELAY_MS: '600000' }, 2, { research: async () => candidates });
  const taskId = await h.create({ contacts: [], supplierKind: 'bakery' }), cookie = await h.login(taskId);
  await h.ok('/tools/confirm-brief', { taskId });
  const found = await h.wait(taskId, cookie, v => v.contacts.length === 1);
  await h.ok(`/api/tasks/${taskId}/contacts`, { permit: [found.contacts[0].id], add: [{ name: 'Owner bakery', phone: '9876543210' }] }, cookie);
  const v = await h.wait(taskId, cookie, v => v.task.attempts.length === 1);
  assert.equal(v.task.attempts[0].supplier, 'Owner bakery');
  const queued = h.app.db.sql.prepare("SELECT * FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId);
  assert.equal(queued.due_at, callingTime(window)); assert.ok(v.events.some(e => /outside calling hours/.test(e.text)));
  h.app.config.ALLOW_NUMBERS = '+91 484 2345678';
  const other = await h.create({ contacts: [], supplierKind: 'bakery' }), otherCookie = await h.login(other);
  await h.ok('/tools/confirm-brief', { taskId: other });
  const otherFound = await h.wait(other, otherCookie, v => v.contacts.length === 1);
  await h.ok(`/api/tasks/${other}/contacts`, { permit: [otherFound.contacts[0].id] }, otherCookie);
  assert.equal((await h.wait(other, otherCookie, v => v.task.attempts.length === 1)).task.attempts[0].supplier, 'Aroma Bakes');
});

test('inbound identify unblocks offers, cancels callbacks, rejects acceptance and does not consume outbound cap', async t => {
  const h = await harness(t, { MAX_ATTEMPTS: '2', SIM_DELAY_MS: '600000' });
  assert.deepEqual(await h.ok('/tools/identify', { phone: '9999999999' }), { role: 'customer' });
  const taskId = await h.create({ contacts: [{ name: 'Supplier', phone: '+919876543210' }] }), cookie = await h.login(taskId);
  await h.ok('/tools/confirm-brief', { taskId });
  await h.wait(taskId, cookie, v => v.task.attempts.length === 1);
  const first = h.attempt(taskId);
  await h.ok(`/webhooks/sarvam?token=${WEBHOOK_SECRET}`, { attempt_id: first.provider_attempt_id, status: 'connected' });
  assert.equal((await h.view(taskId, cookie)).task.state, 'Blocked');
  const inbound = await h.ok('/tools/identify', { phone: '09876543210' });
  assert.equal(inbound.role, 'supplier'); assert.equal(inbound.taskId, taskId); assert.ok(Object.values(inbound).every(v => typeof v === 'string'));
  await h.ok('/tools/callback', { taskId, attemptId: inbound.attemptId, minutes: '30' });
  const offer = await h.ok('/tools/offer', { taskId, attemptId: inbound.attemptId, ...quote });
  assert.equal((await h.view(taskId, cookie)).task.state, 'Needs you');
  assert.equal(h.app.db.sql.prepare("SELECT count(*) n FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId).n, 0);
  const rejected = await h.request('/tools/acceptance', { taskId, attemptId: inbound.attemptId, offerId: offer.offerId, offerVersion: offer.offerVersion, accepted: true });
  assert.equal(rejected.status, 403); assert.match(rejected.data.error, /outbound confirmation/);
  await h.ok(`/api/tasks/${taskId}/approve`, { offerId: offer.offerId, offerVersion: offer.offerVersion }, cookie);
  const final = await h.wait(taskId, cookie, v => v.task.attempts.some(a => a.purpose === 'confirm'));
  assert.equal(final.task.state, 'Awaiting confirmation'); assert.equal(final.task.attempts.length, 3);
});

test('implausible upfront and totals cannot be approved; owner still has correction actions', async t => {
  const h = await harness(t), { taskId, cookie, v } = await h.ready();
  const o = v.offers[0];
  await h.ok('/tools/offer', { taskId, attemptId: o.attempt_id, ...o.terms, upfront: 5000 });
  const changed = (await h.view(taskId, cookie)).offers.find(o => o.validity === 'current' && o.supplier === 'Printer A');
  assert.equal(changed.suitable, false); assert.equal(changed.implausible, true);
  assert.ok(changed.reasons.includes('Upfront payment ₹5000 is more than the total ₹2300; treat this quote as unreliable until the supplier corrects it.'));
  assert.equal((await h.request(`/api/tasks/${taskId}/approve`, { offerId: changed.id, offerVersion: changed.version }, cookie)).status, 409);
  assert.ok(changed.canCounter);
});

test('queued advice rejects foreign ids, stores valid suggestions, and never takes an owner action', async t => {
  let foreignId = 'another-task-offer';
  const h = await harness(t, {}, 2, { advise: async () => ({ recommendOfferId: foreignId, counterOfferId: null, counterAsk: null, summary: 'Choose this offer.' }) });
  const other = await h.ready(); foreignId = other.v.offers[0].id;
  const { taskId, cookie } = await h.ready();
  const fallback = await h.wait(taskId, cookie, v => !!v.task.advice);
  assert.equal(fallback.task.advice.source, 'rules'); assert.equal(fallback.task.advice.recommendOfferId, fallback.offers[0].id);
  h.options.advise = async v => adviceFor(v);
  await h.app.close(); h.app = await startServer(h.options);
  const offer = fallback.offers[0];
  await h.ok('/tools/offer', { taskId, attemptId: offer.attempt_id, ...offer.terms, basePrice: 2250 });
  const advised = await h.wait(taskId, cookie, v => v.task.advice?.source === 'codex');
  assert.equal(advised.task.advice.summary, adviceFor(advised).summary);
  assert.equal(advised.task.state, 'Needs you'); assert.equal(advised.task.attempts.length, fallback.task.attempts.length);
  assert.equal(h.app.db.sql.prepare('SELECT count(*) n FROM approvals WHERE task_id=?').get(taskId).n, 0);
});

test('budget disclosure is opt-in for flat drafts, supplier variables and inbound identify', async t => {
  const h = await harness(t, { SIM_DELAY_MS: '600000' });
  for (const discloseBudget of [undefined, 'false', 'yes']) {
    const taskId = await h.create({ discloseBudget, contacts: [{ name: 'Supplier', phone: '+919876543210' }] }), cookie = await h.login(taskId);
    await h.ok('/tools/confirm-brief', { taskId });
    await h.wait(taskId, cookie, v => v.task.attempts.length === 1);
    assert.equal(h.app.db.task(taskId).discloseBudget, false);
    assert.equal(Object.hasOwn(JSON.parse(h.attempt(taskId).variables), 'budgetMax'), false);
    const inbound = await h.ok('/tools/identify', { phone: '9876543210' });
    assert.equal(inbound.taskId, taskId); assert.equal(Object.hasOwn(inbound, 'budget_max'), false);
    assert.ok(!JSON.stringify(inbound).includes('2500'));
  }
});

// Database tests use a disposable on-disk database and no sockets. They also run in restricted sandboxes.
function storeHarness(t, config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kairos-store-test-')), path = join(dir, 'test.db');
  const settings = { MAX_ATTEMPTS: '6', SIM_DELAY_MS: '0', RESEARCH_CALL_HOURS: '00:00-00:00', ...config };
  const db = openDb(path, settings);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const create = input => db.createDraft(brief(input)).taskId;
  const drain = (researchFake = () => [], adviseFake = ruleAdvice) => {
    for (let i = 0; i < 100; i++) {
      const action = db.claim(); if (!action) return;
      if (action.type === 'research') db.researchResult(action, researchFake(db.task(action.task_id)));
      else if (action.type === 'think') db.adviceResult(action, adviseFake(db.view(action.task_id)));
      else if (action.type === 'call') { const call = db.prepareCall(action); if (call) db.dispatched(call.attemptId, { attemptId: `sim-${call.attemptId}`, simulated: true }); }
      else if (action.type === 'simulate') { simulate(db, action.payload.attemptId); db.finishAction(action.id); }
      else db.finishAction(action.id);
    }
    assert.fail('Worker did not settle');
  };
  return { db, create, drain, settings };
}

test('store: original question, counter, approval and confirmation workflow remains sequential', t => {
  const { db, create, drain } = storeHarness(t), taskId = create(); db.confirmBrief(taskId); drain();
  let v = db.view(taskId); assert.equal(v.currentAction.type, 'question');
  db.answer(taskId, { questionId: v.questions[0].id, answer: 'A5' }); drain();
  v = db.view(taskId); assert.equal(v.task.state, 'Needs you'); assert.equal(v.offers.length, 2); assert.equal(v.task.advice.source, 'rules');
  const second = v.offers[1]; db.counter(taskId, { offerId: second.id }); drain();
  v = db.view(taskId); const chosen = v.offers.find(o => o.id === second.id && o.validity === 'current');
  assert.equal(chosen.total, 2200); db.approve(taskId, { offerId: chosen.id, offerVersion: chosen.version }, brief().ownerPhone); drain();
  assert.equal(db.task(taskId).state, 'Confirmed'); assert.equal(db.view(taskId).task.attempts.length, 5);
});

test('store: discovery dedupes, masks numbers, persists permission and schedules both suppliers', t => {
  const { db, create, drain } = storeHarness(t, { SIM_DELAY_MS: '600000' });
  const taskId = create({ contacts: undefined, supplierKind: 'bakery', location: 'Kochi' });
  assert.equal(db.task(taskId).supplierKind, 'bakery'); assert.equal(db.confirmBrief(taskId).research, true);
  drain(() => candidates); const v = db.view(taskId);
  assert.equal(v.contacts.length, 1); assert.equal(v.contacts[0].permitted, 0); assert.equal(db.task(taskId).state, 'Needs you');
  assert.throws(() => db.contacts(taskId, { permit: [], add: [] }), /Choose or add/);
  db.contacts(taskId, { permit: [v.contacts[0].id], add: [{ name: 'Owner bakery', phone: '9876543210' }] }); drain();
  const a = db.sql.prepare('SELECT * FROM call_attempts WHERE task_id=?').get(taskId);
  db.offer({ taskId, attemptId: a.id, ...quote }); db.sarvamWebhook({ attempt_id: a.provider_attempt_id, status: 'connected' }); drain();
  assert.deepEqual(db.view(taskId).task.attempts.map(a => a.supplier), ['Aroma Bakes', 'Owner bakery']);
  assert.equal(db.sql.prepare("SELECT count(*) n FROM notifications WHERE action_key=?").get(`${taskId}:initial`).n, 1);
  assert.equal(db.participant(v.contacts[0].id).phone, '+914842345678');
});

test('store: calling windows and allow-list preserve immediate owner calls and serialized dispatch', t => {
  assert.equal(callingTime('09:00-20:00', Date.parse('2030-01-01T08:00:00+05:30')), Date.parse('2030-01-01T09:00:00+05:30'));
  assert.equal(callingTime('09:00-20:00', Date.parse('2030-01-01T20:00:00+05:30')), Date.parse('2030-01-02T09:00:00+05:30'));
  assert.equal(callingTime('22:00-06:00', Date.parse('2030-01-01T23:00:00+05:30')), Date.parse('2030-01-01T23:00:00+05:30'));
  const hour = (new Date(Date.now() + 330 * 60_000).getUTCHours() + 12) % 24, window = `${String(hour).padStart(2,'0')}:00-${String(hour).padStart(2,'0')}:01`;
  const { db, create, drain, settings } = storeHarness(t, { SIM_DELAY_MS: '600000', RESEARCH_CALL_HOURS: window });
  const taskId = create({ contacts: [], supplierKind: 'bakery' }); db.confirmBrief(taskId); drain(() => candidates);
  const p = db.view(taskId).contacts[0]; db.contacts(taskId, { permit: [p.id], add: [{ name: 'Owner', phone: '9876543210' }] }); drain();
  assert.deepEqual(db.view(taskId).task.attempts.map(a => a.supplier), ['Owner']);
  const q = db.sql.prepare("SELECT * FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId);
  assert.equal(q.due_at, callingTime(window));
  settings.ALLOW_NUMBERS = '0484 2345678'; db.sql.prepare('UPDATE actions SET due_at=0 WHERE id=?').run(q.id);
  drain(); assert.equal(db.view(taskId).task.attempts.length, 1, 'a pending call cannot overlap the owner call');
  const another = create({ contacts: [], supplierKind: 'bakery' }); db.confirmBrief(another); drain(() => candidates);
  db.contacts(another, { permit: [db.view(another).contacts[0].id] }); drain(); assert.equal(db.view(another).task.attempts.length, 1);
});

test('store: inbound offer unblocks and preserves outbound cap; callback is cancelled', t => {
  const { db, create, drain } = storeHarness(t, { MAX_ATTEMPTS: '2', SIM_DELAY_MS: '600000' });
  const taskId = create({ contacts: [{ name: 'Supplier', phone: '+919876543210' }] }); db.confirmBrief(taskId); drain();
  const a = db.sql.prepare('SELECT * FROM call_attempts WHERE task_id=?').get(taskId);
  db.sarvamWebhook({ attempt_id: a.provider_attempt_id, status: 'connected' }); assert.equal(db.task(taskId).state, 'Blocked');
  const inbound = db.identify({ phone: '09876543210' }); assert.equal(inbound.role, 'supplier');
  assert.equal(db.attempt(inbound.attemptId).provider, 'sarvam-inbound');
  db.callback({ taskId, attemptId: inbound.attemptId, minutes: 30 });
  const o = db.offer({ taskId, attemptId: inbound.attemptId, ...quote }); assert.equal(db.task(taskId).state, 'Needs you');
  assert.equal(db.sql.prepare("SELECT count(*) n FROM actions WHERE task_id=? AND type='call' AND status='queued'").get(taskId).n, 0);
  assert.throws(() => db.acceptance({ taskId, attemptId: inbound.attemptId, offerId: o.offerId, offerVersion: o.offerVersion, accepted: true }), /outbound confirmation/);
  assert.equal(db.task(taskId).state, 'Needs you');
  db.approve(taskId, { offerId: o.offerId, offerVersion: o.offerVersion }, brief().ownerPhone); drain();
  assert.equal(db.view(taskId).task.attempts.length, 3); assert.equal(db.task(taskId).state, 'Awaiting confirmation');
  assert.deepEqual(db.identify({ phone: '9876543210' }), { role: 'customer' });
});

test('store: implausible payments, extreme totals and all-implausible review', () => {
  for (const payment of ['upfront','deposit']) {
    const fit = suitability(brief(), { ...quote, [payment]: 5000 }); assert.equal(fit.suitable, false); assert.equal(fit.implausible, true);
    assert.ok(fit.reasons.includes('Upfront payment ₹5000 is more than the total ₹2000; treat this quote as unreliable until the supplier corrects it.'));
  }
  const fit = suitability(brief(), { ...quote, basePrice: 13000 }); assert.ok(fit.reasons.includes('Total ₹13000 is far above the ₹2500 budget.'));
  assert.equal(nextAction({ task: brief(), questions: [], offers: [{ ...fit, validity: 'current' }], participants: [], attempts: [] }).type, 'review_quotes');
  assert.equal(indianPhone('+1 212 555 1234'), null); assert.equal(indianPhone('0484-2345678'), '+914842345678'); assert.equal(indianPhone('011 23456789'), '+911123456789');
});

test('store: advice validation, stale result suppression, rule fallback and private counter variables', async t => {
  const { db, create, drain } = storeHarness(t), taskId = create(); db.confirmBrief(taskId); drain();
  db.answer(taskId, { questionId: db.view(taskId).questions[0].id, answer: 'A5' });
  drain(() => [], () => ({ recommendOfferId: 'foreign', counterOfferId: null, counterAsk: null, summary: 'Wrong task' }));
  assert.equal(db.task(taskId).advice.source, 'rules'); assert.equal(db.task(taskId).state, 'Needs you');
  const prior = db.view(taskId).offers[0]; db.offer({ taskId, attemptId: prior.attempt_id, ...prior.terms, basePrice: 2250 }); drain(() => [], adviceFor);
  assert.equal(db.task(taskId).advice.source, 'codex'); assert.equal(db.task(taskId).state, 'Needs you');
  assert.equal(db.sql.prepare('SELECT count(*) n FROM approvals WHERE task_id=?').get(taskId).n, 0);
  const completed = db.sql.prepare("SELECT * FROM actions WHERE task_id=? AND kind='think' ORDER BY id DESC LIMIT 1").get(taskId);
  db.revise(taskId, { outcome: 'Print 200 flyers' });
  db.adviceResult({ ...completed, payload: JSON.parse(completed.payload) }, adviceFor(db.view(taskId)));
  assert.equal(db.task(taskId).advice, null);
  const privateAdvice = validateAdvice({ recommendOfferId: null, counterOfferId: 'offer', counterAsk: 'Include fees within ₹2500.', summary: 'Ask for fees to be included.' }, { task: { ...brief(), revision: 1 }, offers: [{ id: 'offer', task_revision: 1, validity: 'current', canCounter: true }] });
  const variables = supplierVariables({ ...brief(), id: taskId }, {}, 'counter', { counterAsk: privateAdvice.counterAsk });
  assert.equal(variables.counter_ask, privateAdvice.counterAsk);
  assert.ok(!JSON.stringify(variables).includes('2500')); assert.equal(flat(variables).budget_max, ''); assert.ok(flat(variables).counter_ask);
  assert.deepEqual(await research(brief(), {}), []); assert.equal((await advise(db.view(taskId), {})).source, 'rules');
  for (const value of [undefined, 'false', 'yes', false]) assert.equal(coerce({ discloseBudget: value }).discloseBudget, false);
  assert.equal(coerce({ discloseBudget: 'true' }).discloseBudget, true);
});

test('store: empty research, revision recovery, stopped results and privacy defaults', t => {
  const { db, create, drain } = storeHarness(t);
  const taskId = create({ contacts: [], supplierKind: 'bakery', discloseBudget: undefined });
  db.confirmBrief(taskId); drain();
  assert.equal(db.task(taskId).state, 'Needs you'); assert.equal(db.task(taskId).discloseBudget, false);
  assert.ok(db.view(taskId).events.some(e => e.text === 'Kairos could not find suppliers automatically. Add a name and number to continue.'));
  db.revise(taskId, { location: 'Kochi' });
  let researchAction = db.claim(); assert.equal(researchAction.type, 'research');
  db.recover(); researchAction = db.claim(); assert.equal(researchAction.type, 'research');
  assert.equal(db.task(taskId).state, 'Needs you');
  db.stop(taskId); db.researchResult(researchAction, candidates); assert.equal(db.view(taskId).contacts.length, 0);
  const other = create({ contacts: [{ name: 'Supplier', phone: '+919876543210' }], discloseBudget: undefined });
  db.confirmBrief(other); const identified = db.identify({ phone: '9876543210' });
  assert.equal(Object.hasOwn(identified, 'budget_max'), false); assert.ok(!JSON.stringify(identified).includes('2500'));
  db.sql.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', other);
  assert.deepEqual(db.identify({ phone: '9876543210' }), { role: 'customer' });
  db.purgeExpired(24); assert.equal(db.sql.prepare('SELECT count(*) n FROM actions WHERE task_id=?').get(other).n, 0);
});

test('store: owner-started counter passes stored advice only to the counter call', t => {
  const { db, create, drain } = storeHarness(t, { SIM_DELAY_MS: '600000' });
  const taskId = create({ contacts: [{ name: 'Supplier', phone: '+919876543210' }], discloseBudget: true });
  db.confirmBrief(taskId); drain();
  const a = db.sql.prepare('SELECT * FROM call_attempts WHERE task_id=?').get(taskId);
  const offer = db.offer({ taskId, attemptId: a.id, ...quote, basePrice: 3000 });
  db.sarvamWebhook({ attempt_id: a.provider_attempt_id, status: 'connected' });
  drain(() => [], () => ({ recommendOfferId: null, counterOfferId: offer.offerId, counterAsk: 'Please include fees within ₹2500.', summary: 'Ask for an all-inclusive price.' }));
  assert.equal(db.view(taskId).task.attempts.length, 1); assert.equal(db.task(taskId).state, 'Needs you');
  db.counter(taskId, { offerId: offer.offerId }); const action = db.claim(), call = db.prepareCall(action);
  const variables = supplierVariables(call.task, call.participant, call.purpose, call);
  assert.equal(variables.counter_ask, db.task(taskId).advice.counterAsk); assert.equal(flat(variables).counter_ask, variables.counter_ask);
  assert.equal(Object.hasOwn(supplierVariables(call.task, call.participant, 'collect_offer', call), 'counter_ask'), false);
  assert.equal(db.identify({ phone: '9876543210' }).role, 'customer');
});

test('returning customer hears a state-level status; a 24-hour business found by research is called at once', async t => {
  const research = async () => [{ name: 'Night Bakes', phone: '+91 98470 11111', sourceUrl: 'https://example.com/n', note: 'Cakes · Hours: Open 24 hours' }, { name: 'Day Bakes', phone: '+91 98470 22222', sourceUrl: 'https://example.com/d', note: 'Cakes' }];
  const h = await harness(t, { RESEARCH_CALL_HOURS: '00:00-00:01', SIM_DELAY_MS: '600000' });
  await h.app.close(); h.app = await startServer({ ...h.options, research });
  assert.deepEqual(await h.ok('/tools/identify', { phone: '+919999900000' }), { role: 'customer' });
  const { taskId } = await h.ok('/tools/draft', brief({ ownerPhone: '+919999900000', contacts: [], supplierKind: 'bakery', location: 'Kochi' }));
  await h.ok('/tools/confirm-brief', { taskId });
  let v; for (let i = 0; i < 300 && !((v = h.app.db.view(taskId)).contacts?.length >= 2); i++) await sleep(10);
  const who = await h.ok('/tools/identify', { phone: '09999900000' });
  assert.equal(who.role, 'owner'); assert.equal(who.ownerTaskId, taskId); assert.match(who.status_summary, /found 2 possible suppliers/);
  assert.ok(!/₹|\d{4,}/.test(who.status_summary), 'no prices or numbers in a caller-ID status');
  const cookie = await h.login(taskId);
  await h.ok(`/api/tasks/${taskId}/contacts`, { permit: v.contacts.map(c => c.id) }, cookie);
  let first; for (let i = 0; i < 300 && !(first = h.app.db.sql.prepare('SELECT p.name FROM call_attempts a JOIN participants p ON p.id=a.participant_id WHERE a.task_id=?').get(taskId)); i++) await sleep(10);
  assert.equal(first?.name, 'Night Bakes');
});
