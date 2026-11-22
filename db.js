import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { nextAction, validateAdvice } from './thinker.js';

const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const json = value => JSON.stringify(value);
const parse = value => value == null ? null : JSON.parse(value);
const hash = value => createHash('sha256').update(value).digest('hex');
export function secretEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
function check(ok, message, status = 409) { if (!ok) { const e = new Error(message); e.status = status; throw e; } }
function text(value, name, max = 5000) { check(typeof value === 'string' && value.trim() && value.length <= max, `Invalid ${name}`, 400); return value.trim(); }
function money(value, field) { check(value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0), `Invalid ${field}`, 400); return value ?? null; }
function list(value, field) { check(Array.isArray(value) && value.length <= 30, `Invalid ${field}`, 400); return value; }
const phone = value => { check(typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(value), 'Use an international phone number', 400); return value; };
const activeAttempt = "('dispatching','awaiting_callback','uncertain')";

// Indian mobile numbers and STD landlines, with optional country/trunk prefix.
export function indianPhone(value) {
  if (typeof value !== 'string' || !/^\+?[\d\s().-]+$/.test(value.trim())) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[1-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
const lastTen = value => String(value || '').replace(/\D/g, '').slice(-10);
// India has no daylight-saving transitions. Windows may also cross midnight.
export function callingTime(value, time = Date.now()) {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value || '09:00-20:00');
  check(match && +match[1] < 24 && +match[3] < 24 && +match[2] < 60 && +match[4] < 60, 'Invalid RESEARCH_CALL_HOURS', 400);
  const start = +match[1] * 60 + +match[2], end = +match[3] * 60 + +match[4];
  const local = new Date(time + 330 * 60_000), minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end)) return time;
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 330 * 60_000;
  return midnight + start * 60_000 + (minute >= start ? 86400_000 : 0);
}
export function suitability(task, terms, validity = 'current') {
  const reasons = [];
  const missing = [...terms.unknown];
  for (const key of ['basePrice', 'fees', 'taxes', 'deposit', 'upfront']) if (terms[key] === null) missing.push(key);
  const total = ['basePrice', 'fees', 'taxes'].every(k => terms[k] !== null) ? Math.round((terms.basePrice + terms.fees + terms.taxes) * 100) / 100 : null;
  if (validity !== 'current') reasons.push(validity === 'recheck' ? 'Request changed; this offer needs rechecking.' : 'Replaced by a newer offer version.');
  if (total === null) reasons.push('Unknown charges: cannot confirm within budget.');
  if (total !== null && task.budgetMax !== null && total > task.budgetMax) reasons.push(`Total ₹${total} exceeds the ₹${task.budgetMax} budget, including fees and taxes.`);
  let implausible = false;
  const knownTotal = terms.basePrice !== null ? terms.basePrice + (terms.fees ?? 0) + (terms.taxes ?? 0) : null;
  const payment = Math.max(terms.upfront ?? 0, terms.deposit ?? 0);
  if (knownTotal !== null && payment > knownTotal) {
    implausible = true;
    reasons.push(`Upfront payment ₹${payment} is more than the total ₹${knownTotal}; treat this quote as unreliable until the supplier corrects it.`);
  }
  if (total !== null && task.budgetMax !== null && total > 5 * task.budgetMax) {
    implausible = true; reasons.push(`Total ₹${total} is far above the ₹${task.budgetMax} budget.`);
  }
  if (task.deadline) {
    if (!terms.deadline || !Number.isFinite(Date.parse(terms.deadline))) reasons.push('Delivery or appointment deadline is unconfirmed.');
    else if (Date.parse(terms.deadline) > Date.parse(task.deadline)) reasons.push('The offered deadline misses your required deadline.');
  }
  const facts = `${typeof terms.spec === 'string' ? terms.spec : json(terms.spec)} ${terms.availability || ''}`.toLowerCase();
  for (const constraint of task.hardConstraints) {
    // Free-text facts must be explicitly present; unknown requirements are never inferred as met.
    if (typeof constraint === 'string') {
      if (!facts.includes(constraint.toLowerCase())) reasons.push(`Cannot verify hard requirement: ${constraint}`);
    } else if (constraint && typeof constraint === 'object') {
      const actual = terms.spec && typeof terms.spec === 'object' ? terms.spec[constraint.field] : undefined;
      const ok = constraint.operator === '>=' ? Number.isFinite(actual) && actual >= constraint.value : constraint.operator === '<=' ? Number.isFinite(actual) && actual <= constraint.value : actual === constraint.value;
      if (!ok) reasons.push(`Hard requirement not met or unverified: ${constraint.field} ${constraint.operator || '='} ${constraint.value}`);
    } else reasons.push('An unresolved hard requirement needs clarification.');
  }
  if (terms.deposit === null || terms.upfront === null) reasons.push('Deposit or upfront payment is unknown.');
  if (terms.unknown.length) reasons.push(`Missing details: ${terms.unknown.join(', ')}`);
  return { total, implausible, missing: [...new Set(missing)], suitable: reasons.length === 0, reasons };
}

export function openDb(path, config = {}) {
  const sql = new DatabaseSync(path);
  sql.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, subdomain TEXT NOT NULL UNIQUE, owner_phone TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), brief TEXT NOT NULL CHECK(json_valid(brief)),
      state TEXT NOT NULL CHECK(state IN ('Draft','Working','Needs you','Awaiting confirmation','Awaiting required action','Completed','Confirmed','Needs reconciliation','Blocked','Stopped')),
      stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1)), layout TEXT NOT NULL DEFAULT '[]',
      arrangement TEXT, outcome_record TEXT, blocked_reason TEXT, simulated INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), role TEXT NOT NULL DEFAULT 'supplier',
      name TEXT NOT NULL, phone TEXT NOT NULL, ordinal INTEGER NOT NULL, permitted INTEGER NOT NULL CHECK(permitted IN (0,1)),
      disclosures TEXT NOT NULL, consent TEXT NOT NULL, UNIQUE(task_id,phone)
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('call','notify','simulate')), action_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','in_flight','done','failed','uncertain','cancelled')),
      due_at INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
    );
    CREATE TABLE IF NOT EXISTS call_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id), action_id INTEGER NOT NULL UNIQUE REFERENCES actions(id),
      provider TEXT NOT NULL, provider_attempt_id TEXT, purpose TEXT NOT NULL CHECK(purpose IN ('collect_offer','counter','confirm')),
      status TEXT NOT NULL, payload TEXT NOT NULL, variables TEXT, created_at TEXT NOT NULL, completed_at TEXT,
      duration REAL, failure_reason TEXT, notes TEXT, UNIQUE(provider,provider_attempt_id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, text TEXT NOT NULL,
      data TEXT NOT NULL, state TEXT NOT NULL, simulated INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
    DROP TRIGGER IF EXISTS events_no_delete;
    CREATE TRIGGER events_no_delete BEFORE DELETE ON events WHEN EXISTS(SELECT 1 FROM tasks WHERE id=OLD.task_id) BEGIN SELECT RAISE(ABORT,'Events are append-only'); END;
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id), attempt_id TEXT NOT NULL REFERENCES call_attempts(id),
      text TEXT NOT NULL, answer TEXT, resumed INTEGER NOT NULL DEFAULT 0, event_id INTEGER NOT NULL REFERENCES events(id),
      created_at TEXT NOT NULL, answered_at TEXT, UNIQUE(attempt_id,text)
    );
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id), attempt_id TEXT NOT NULL REFERENCES call_attempts(id),
      terms TEXT NOT NULL, validity TEXT NOT NULL CHECK(validity IN ('current','recheck','superseded')),
      event_id INTEGER NOT NULL REFERENCES events(id), created_at TEXT NOT NULL,
      PRIMARY KEY(id,version), UNIQUE(task_id,participant_id,version)
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_revision INTEGER NOT NULL,
      offer_id TEXT NOT NULL, offer_version INTEGER NOT NULL, owner_phone TEXT NOT NULL,
      terms TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)), created_at TEXT NOT NULL,
      FOREIGN KEY(offer_id,offer_version) REFERENCES offers(id,version), UNIQUE(task_id,task_revision,offer_id,offer_version)
    );
    CREATE TRIGGER IF NOT EXISTS offer_terms_immutable BEFORE UPDATE OF id,version,task_id,task_revision,participant_id,terms ON offers
      BEGIN SELECT RAISE(ABORT,'Changed terms require a new offer version'); END;
    CREATE TRIGGER IF NOT EXISTS approval_terms_immutable BEFORE UPDATE OF task_id,task_revision,offer_id,offer_version,owner_phone,terms ON approvals
      BEGIN SELECT RAISE(ABORT,'Approval terms are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_cannot_revalidate BEFORE UPDATE OF valid ON approvals
      WHEN OLD.valid=0 AND NEW.valid=1 BEGIN SELECT RAISE(ABORT,'Invalid approvals cannot be revalidated'); END;
    CREATE TRIGGER IF NOT EXISTS approval_guard BEFORE INSERT ON approvals BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks t JOIN offers o ON o.task_id=t.id
        WHERE t.id=NEW.task_id AND t.revision=NEW.task_revision AND t.owner_phone=NEW.owner_phone AND t.stopped=0
        AND o.id=NEW.offer_id AND o.version=NEW.offer_version AND o.task_revision=t.revision AND o.validity='current'
        AND o.terms=NEW.terms AND NOT EXISTS(SELECT 1 FROM offers n WHERE n.id=o.id AND n.version>o.version))
        THEN RAISE(ABORT,'Approval does not match current authority') END;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_revision AFTER UPDATE OF revision,stopped ON tasks
      WHEN NEW.revision<>OLD.revision OR NEW.stopped=1 BEGIN
      UPDATE approvals SET valid=0 WHERE task_id=NEW.id;
      UPDATE offers SET validity='recheck' WHERE task_id=NEW.id AND validity='current' AND NEW.revision<>OLD.revision;
    END;
    CREATE TRIGGER IF NOT EXISTS invalidate_offer AFTER INSERT ON offers BEGIN
      UPDATE approvals SET valid=0 WHERE offer_id=NEW.id AND offer_version<NEW.version;
      UPDATE offers SET validity='superseded' WHERE id=NEW.id AND version<NEW.version;
    END;
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), action_key TEXT NOT NULL UNIQUE REFERENCES actions(action_key),
      kind TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'sms', body TEXT NOT NULL,
      status TEXT NOT NULL, provider_id TEXT, response TEXT, error TEXT, retry_status TEXT NOT NULL DEFAULT 'no automatic retry', created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS callback_events (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, provider_attempt_id TEXT NOT NULL,
      task_id TEXT REFERENCES tasks(id), payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(provider,provider_attempt_id)
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), filename TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      content_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size<=10485760), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otps (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id), code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts<=5), sends INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, owner_phone TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
    );`);
  for (const col of ['callback_at INTEGER', 'callback_done INTEGER NOT NULL DEFAULT 0']) { try { sql.exec(`ALTER TABLE call_attempts ADD COLUMN ${col}`); } catch { /* already present */ } }
  // Keep the original CHECK constraint and all live foreign keys intact.
  // New action kinds use the legacy simulate envelope, decoded by claim().
  for (const [table, columns] of Object.entries({ tasks: ['advice TEXT'], participants: ["source TEXT NOT NULL DEFAULT 'owner' CHECK(source IN ('owner','research'))", 'source_url TEXT', 'note TEXT'], actions: ['kind TEXT'] })) {
    for (const col of columns) { try { sql.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* already present */ } }
  }
  const get = (q, ...args) => sql.prepare(q).get(...args);
  const all = (q, ...args) => sql.prepare(q).all(...args);
  const run = (q, ...args) => sql.prepare(q).run(...args);
  const atomic = fn => {
    if (sql.isTransaction) return fn();
    sql.exec('BEGIN IMMEDIATE');
    try { const result = fn(); sql.exec('COMMIT'); return result; } catch (e) { sql.exec('ROLLBACK'); throw e; }
  };
  const maxAttempts = Number(config.MAX_ATTEMPTS || 6);
  check(Number.isInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 6, 'MAX_ATTEMPTS must be 1–6', 400);
  function task(taskId) {
    const row = get('SELECT * FROM tasks WHERE id=?', taskId);
    check(row, 'Task not found', 404);
    return { ...parse(row.brief), ...row, existingArrangement: parse(row.arrangement), outcomeRecord: parse(row.outcome_record), layout: parse(row.layout), advice: parse(row.advice), simulated: !!row.simulated, stopped: !!row.stopped };
  }
  function event(taskId, kind, message, data = {}) {
    const t = task(taskId);
    const result = run('INSERT INTO events(task_id,kind,text,data,state,simulated,created_at) VALUES(?,?,?,?,?,?,?)', taskId, kind, message, json(data), t.state, +t.simulated, now());
    run('UPDATE tasks SET updated_at=? WHERE id=?', now(), taskId);
    return Number(result.lastInsertRowid);
  }
  function state(taskId, value, reason = null) { run('UPDATE tasks SET state=?,blocked_reason=?,updated_at=? WHERE id=?', value, reason, now(), taskId); }
  function enqueue(taskId, type, key, payload, due = 0) {
    const t = task(taskId);
    run('INSERT OR IGNORE INTO actions(task_id,task_revision,type,kind,action_key,payload,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, t.revision, ['research','think','inbound','owner_call'].includes(type) ? 'simulate' : type, type, key, json(payload), due, now(), now());
  }
  function link(t) { return `${(config.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '')}/t/${t.id}`; }
  function notify(taskId, key, message, kind = 'update') {
    enqueue(taskId, 'notify', key, {});
    run('INSERT OR IGNORE INTO notifications(id,task_id,action_key,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?)', id(), taskId, key, kind, message, 'queued', now());
  }
  function block(taskId, reason) { state(taskId, 'Blocked', reason); event(taskId, 'blocked', reason); }
  function allowed(t) { check(!t.stopped && !['Draft', 'Needs reconciliation', 'Confirmed', 'Completed', 'Awaiting required action'].includes(t.state), `Task is ${t.state}`); }
  function attempt(attemptId) {
    const a = get('SELECT * FROM call_attempts WHERE id=? OR provider_attempt_id=?', attemptId, attemptId);
    check(a, 'Unknown call attempt', 404); return a;
  }
  function source(input, allowStale = false) {
    const a = attempt(input.attemptId), t = task(input.taskId);
    check(a.task_id === t.id, 'Attempt belongs to another task', 403);
    const p = get('SELECT * FROM participants WHERE id=? AND task_id=?', a.participant_id, t.id);
    check(p, 'Unknown supplier', 403);
    if (!allowStale) { allowed(t); check((p.permitted || a.provider === 'sarvam-inbound') && a.task_revision === t.revision, 'Stale call or revoked contact permission'); }
    return { a, t, p };
  }
  function offerRow(offerId, version) {
    const o = version === undefined ? get('SELECT * FROM offers WHERE id=? ORDER BY version DESC LIMIT 1', offerId) : get('SELECT * FROM offers WHERE id=? AND version=?', offerId, version);
    check(o, 'Offer not found', 404); return { ...o, terms: parse(o.terms) };
  }
  function queueCall(taskId, participantId, purpose, payload = {}) {
    const t = task(taskId); allowed(t);
    check(!get(`SELECT 1 FROM call_attempts WHERE task_id=? AND provider<>'sarvam-inbound' AND status IN ${activeAttempt}`, taskId), 'A call is still in flight or uncertain');
    check(!get("SELECT 1 FROM actions WHERE task_id=? AND type='call' AND (status='in_flight' OR (status='queued' AND due_at<=?))", taskId, Date.now()), 'A call is already queued');
    const p = get('SELECT * FROM participants WHERE id=? AND task_id=? AND permitted=1', participantId, taskId);
    check(p, 'Contact is not permitted', 403);
    if (get('SELECT count(*) AS n FROM call_attempts WHERE task_id=? AND provider<>\'sarvam-inbound\'', taskId).n >= maxAttempts) { block(taskId, `The ${maxAttempts}-call limit is exhausted. Start a new task with confirmed details and reachable contacts to continue.`); return; }
    if (purpose === 'counter') {
      check(t.mayCounter, 'Counteroffers are not authorised');
      check(!get("SELECT 1 FROM call_attempts WHERE task_id=? AND participant_id=? AND purpose='counter'", taskId, participantId), 'Only one counteroffer round is permitted per supplier');
    }
    if (purpose === 'confirm') check(db.authority(taskId, payload.offerId, payload.offerVersion).ok, 'Approval is no longer valid');
    const key = `${taskId}:r${t.revision}:${purpose}:${participantId}:${payload.questionId || payload.offerVersion || (payload.callbackOf ? `cb${payload.callbackOf}` : 'initial')}`;
    const requested = Math.max(Date.now(), payload.dueAt || 0), due = gatedTime(p, requested);
    enqueue(taskId, 'call', key, { participantId, purpose, ...payload }, due);
    if (due > requested) gateEvent(taskId, p, due);
    const openQuestion = get('SELECT 1 FROM questions WHERE task_id=? AND task_revision=? AND answer IS NULL', taskId, t.revision);
    state(taskId, purpose === 'confirm' ? 'Awaiting confirmation' : openQuestion ? 'Needs you' : 'Working');
    if (payload.questionId) run('UPDATE questions SET resumed=1 WHERE id=?', payload.questionId);
    event(taskId, 'call_queued', `${purpose === 'confirm' ? 'Seeking exact-term confirmation from' : purpose === 'counter' ? 'Asking for a better offer from' : 'Preparing to call'} ${p.name}.`, { participantId, purpose });
  }
  function plan(taskId) {
    const t = task(taskId);
    if (t.stopped || ['Draft','Awaiting confirmation','Awaiting required action','Confirmed','Completed','Needs reconciliation','Blocked'].includes(t.state)) return;
    if (get(`SELECT 1 FROM call_attempts WHERE task_id=? AND provider<>'sarvam-inbound' AND status IN ${activeAttempt}`, taskId) || get("SELECT 1 FROM actions WHERE task_id=? AND type='call' AND (status='in_flight' OR (status='queued' AND due_at<=?))", taskId, Date.now())) return;
    const permitted = all('SELECT * FROM participants WHERE task_id=? AND permitted=1 ORDER BY ordinal', taskId);
    if (!permitted.length) {
      state(taskId, 'Needs you');
      if (t.supplierKind) enqueue(taskId, 'research', `${taskId}:r${t.revision}:research`, {});
      return;
    }
    const cb = get('SELECT * FROM call_attempts WHERE task_id=? AND task_revision=? AND callback_at IS NOT NULL AND callback_done=0 AND participant_id IN (SELECT id FROM participants WHERE permitted=1) ORDER BY created_at LIMIT 1', taskId, t.revision);
    if (cb) { run('UPDATE call_attempts SET callback_done=1 WHERE id=?', cb.id); queueCall(taskId, cb.participant_id, 'collect_offer', { callbackOf: cb.id, dueAt: cb.callback_at }); plan(taskId); return; }
    const v = db.view(taskId);
    const action = nextAction({ ...v, offers: v.offers.filter(o => o.task_revision === t.revision), questions: v.questions.filter(q => q.task_revision === t.revision && (q.answer === null || permitted.some(p => p.id === q.participant_id))), participants: permitted.filter(p => !get("SELECT 1 FROM actions WHERE task_id=? AND type='call' AND status='queued' AND json_extract(payload,'$.participantId')=?", taskId, p.id)), attempts: all("SELECT * FROM call_attempts WHERE task_id=? AND task_revision=? AND provider<>'sarvam-inbound'", taskId, t.revision) });
    if (action.type === 'call_supplier') {
      queueCall(taskId, action.participantId, action.purpose, { ...(action.questionId ? { questionId: action.questionId } : {}) });
      plan(taskId);
    }
    else if (get("SELECT 1 FROM actions WHERE task_id=? AND type='call' AND status='queued'", taskId)) return;
    else if (action.type === 'block') block(taskId, action.reason);
    else if (action.type === 'complete') {
      state(taskId, 'Completed');
      run('UPDATE tasks SET outcome_record=? WHERE id=?', json({ kind: 'information', text: 'Quote comparison delivered. No booking or purchase has been made.' }), taskId);
      event(taskId, 'completed', 'Quote comparison is ready. No booking or purchase was made.');
      notify(taskId, `${taskId}:r${t.revision}:completed`, `Kairos: your comparison is ready. ${link(t)}`);
    } else {
      if (t.state !== 'Needs you') event(taskId, 'owner_needed', action.type === 'request_answer' ? 'A supplier needs your answer.' : 'Choose an offer, ask for a better offer, or revise the request.');
      state(taskId, 'Needs you');
      if (['request_approval','review_quotes'].includes(action.type)) {
        enqueue(taskId, 'think', `${taskId}:r${t.revision}:think:${offerFingerprint(v)}`, { fingerprint: offerFingerprint(v) });
        notify(taskId, `${taskId}:r${t.revision}:decision:${v.offers.length}`, `Kairos needs your decision. ${link(t)}`);
        enqueue(taskId, 'owner_call', `${taskId}:r${t.revision}:owner_call:${offerFingerprint(v)}`, { fingerprint: offerFingerprint(v) }, Date.now() + Number(config.OWNER_CALL_DELAY_MS ?? 20000));
      }
    }
  }
  // One spoken sentence for a set of terms; an unstated charge is said as "not stated", never as zero.
  function termsSentence(terms) {
    const amount = v => v == null ? 'not stated' : `${v} rupees`, spec = typeof terms.spec === 'string' ? terms.spec : json(terms.spec);
    return `${spec}; price ${amount(terms.basePrice)}, fees ${amount(terms.fees)}, taxes ${amount(terms.taxes)}, upfront ${amount(terms.upfront)}${terms.deposit ? `, deposit ${terms.deposit} rupees` : ''}${terms.deadline ? `, by ${terms.deadline}` : ''}${terms.conditions?.length ? `. Conditions: ${terms.conditions.join('; ')}` : ''}.`;
  }
  function approvalBlocker(terms, fit) {
    if (fit.total === null) return 'The full price is not known yet. Ask the supplier for the missing charges first.';
    if (Math.max(terms.upfront || 0, terms.deposit || 0) > fit.total) return 'The upfront amount is more than the total. Ask the supplier to correct the quote first.';
    return null;
  }
  function offerFingerprint(v) { return hash(json(v.offers.filter(o => o.validity === 'current' && o.task_revision === v.task.revision).map(o => [o.id, o.version]).sort())); }
  function ownerVariables(t, offers, proposed) {
    const terms = proposed.terms, amount = value => value == null ? 'not stated' : `${value} rupees`;
    const spec = typeof terms.spec === 'string' ? terms.spec : Object.entries(terms.spec).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : json(v)}`).join(', ');
    const deadline = terms.deadline && Number.isFinite(Date.parse(terms.deadline)) ? new Date(terms.deadline).toLocaleString('en-GB', { timeZone: t.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : 'not stated';
    return {
      taskId: t.id, offer_id: proposed.id, offer_version: String(proposed.version), request_summary: t.outcome,
      proposed_supplier: proposed.supplier,
      // Spoken aloud: lead with the money, keep it to one short sentence, and never turn an unstated charge into zero.
      proposed_terms: (() => {
        const parts = [['base price', terms.basePrice], ['fees', terms.fees], ['taxes', terms.taxes]], known = parts.filter(([, v]) => v != null), missing = parts.filter(([, v]) => v == null).map(([k]) => k);
        const total = proposed.total != null ? `total ${proposed.total} rupees` : known.length ? `at least ${known.reduce((n, [, v]) => n + v, 0)} rupees, ${missing.join(' and ')} not stated` : 'price not stated';
        const upfront = `${terms.upfront != null ? `${terms.upfront} rupees upfront` : 'upfront amount not stated'}${terms.deposit ? `, ${terms.deposit} rupees deposit` : ''}`;
        return `${spec}: ${total}, ${upfront}, ready by ${deadline}.${terms.conditions.length ? ` Conditions: ${terms.conditions.join('; ')}.` : ''}`;
      })(),
      proposed_problems: proposed.reasons.slice(0, 2).join(' '),
      other_quotes: offers.filter(o => o.id !== proposed.id).map(o => `${o.supplier}: total ${amount(o.total)}.`).join(' '),
      suggestion: t.advice?.summary || '', may_counter: String(!!proposed.canCounter), language: t.language
    };
  }
  function gatedTime(p, time) {
    return p.source === 'research' && !/24\s*(hours|hrs|x\s*7|\/\s*7)/i.test(p.note || '') && !(config.ALLOW_NUMBERS || '').split(',').some(n => n.trim() && lastTen(n) === lastTen(p.phone)) ? callingTime(config.RESEARCH_CALL_HOURS, time) : time;
  }
  function gateEvent(taskId, p, due) {
    const time = new Date(due).toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    event(taskId, 'calling_hours', `${p.name} will be called at ${time}; it is outside calling hours now.`, { participantId: p.id, dueAt: due });
  }
  function insertContact(taskId, input, source, permitted) {
    const number = indianPhone(input.phone); check(number, 'Use a valid Indian mobile or landline number', 400);
    const existing = all('SELECT * FROM participants WHERE task_id=?', taskId).find(p => lastTen(p.phone) === lastTen(number));
    if (existing) {
      if (permitted) run("UPDATE participants SET permitted=1,source='owner',consent='Owner explicitly supplied this contact.' WHERE id=?", existing.id);
      return existing.id;
    }
    const participantId = id();
    run('INSERT INTO participants(id,task_id,name,phone,ordinal,permitted,disclosures,consent,source,source_url,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)', participantId, taskId, text(input.name, 'contact name', 120), number,
      get('SELECT coalesce(max(ordinal),-1)+1 n FROM participants WHERE task_id=?', taskId).n, +permitted, json({ budget: task(taskId).discloseBudget }), permitted ? 'Owner explicitly supplied this contact.' : 'Research candidate; owner permission required.', source, typeof input.sourceUrl === 'string' ? input.sourceUrl.slice(0, 2000) : null, typeof input.note === 'string' ? input.note.slice(0, 500) : null);
    return participantId;
  }
  const db = {
    sql, close: () => sql.close(), task, attempt, participant: participantId => get('SELECT * FROM participants WHERE id=?', participantId),
    researchResult(action, candidates) {
      db.finishAction(action.id);
      if (!get('SELECT 1 FROM tasks WHERE id=?', action.task_id)) return;
      const t = task(action.task_id);
      if (t.stopped || t.revision !== action.task_revision || t.state !== 'Needs you') return;
      for (const candidate of (Array.isArray(candidates) ? candidates : []).slice(0, 5)) {
        if (!candidate || !indianPhone(candidate.phone) || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 120) continue;
        insertContact(t.id, candidate, 'research', false);
      }
      const count = get("SELECT count(*) n FROM participants WHERE task_id=? AND source='research' AND permitted=0", t.id).n;
      event(t.id, 'research', count ? `Kairos found ${count} possible suppliers. Choose who it may call.` : 'Kairos could not find suppliers automatically. Add a name and number to continue.');
    },
    adviceResult(action, advice) {
      db.finishAction(action.id);
      if (!get('SELECT 1 FROM tasks WHERE id=?', action.task_id)) return;
      const t = task(action.task_id), v = db.view(t.id);
      if (t.stopped || t.revision !== action.task_revision || offerFingerprint(v) !== action.payload.fingerprint) return;
      const result = validateAdvice(advice, v, advice?.source === 'rules' ? 'rules' : 'codex');
      run('UPDATE tasks SET advice=?,updated_at=? WHERE id=?', json(result), now(), t.id);
    },
    prepareOwnerCall(action) {
      const t = task(action.task_id), v = db.view(t.id);
      if (t.stopped || t.state !== 'Needs you' || t.revision !== action.task_revision || offerFingerprint(v) !== action.payload.fingerprint) { db.finishAction(action.id, 'cancelled'); return null; }
      if (!get("SELECT 1 FROM actions WHERE id=? AND kind='owner_call' AND status='in_flight'", action.id)) return null;
      if (config.SARVAM_API_KEY && (!config.SARVAM_OWNER_APP_ID || !config.SARVAM_OWNER_APP_VERSION)) {
        event(t.id, 'owner_call', 'Owner call-back is not configured.'); db.finishAction(action.id); return null;
      }
      const offers = v.offers.filter(o => o.validity === 'current' && o.task_revision === t.revision);
      const cheapest = rows => rows.slice().sort((a, b) => a.total - b.total)[0];
      const proposed = offers.find(o => o.id === t.advice?.recommendOfferId) || cheapest(offers.filter(o => o.suitable)) || cheapest(offers.filter(o => o.total !== null)) || offers[0];
      if (!proposed) { db.finishAction(action.id, 'cancelled'); return null; }
      const variables = ownerVariables(t, offers, proposed), simulated = !config.SARVAM_API_KEY;
      run('UPDATE actions SET payload=?,updated_at=? WHERE id=?', json({ ...action.payload, variables, offerId: proposed.id, offerVersion: proposed.version, dispatchedAt: Date.now(), simulated }), now(), action.id);
      event(t.id, 'owner_call', simulated ? 'Simulated call to the owner with the result.' : 'Calling you with the result.');
      if (simulated) { db.finishAction(action.id); return null; }
      return { task: t, variables, actionId: action.id };
    },
    ownerCallDispatched(actionId, result) {
      const action = get("SELECT * FROM actions WHERE id=? AND kind='owner_call'", actionId);
      const payload = parse(action.payload);
      // A completion webhook can arrive before the outbound response.
      if (payload.attemptId) return;
      run('UPDATE actions SET payload=? WHERE id=?', json({ ...payload, attemptId: result.attemptId }), actionId);
      db.finishAction(actionId);
    },
    ownerCallFailed(actionId, error) {
      const action = get("SELECT * FROM actions WHERE id=? AND kind='owner_call'", actionId);
      if (parse(action.payload).attemptId) return;
      const uncertain = error.uncertain || ['TimeoutError','AbortError','TypeError'].includes(error.name);
      db.finishAction(actionId, uncertain ? 'uncertain' : 'failed', error.message);
      event(action.task_id, 'owner_call_failed', uncertain ? 'Owner call dispatch outcome unknown. No automatic retry will be made.' : `Owner call dispatch failed: ${error.message}`);
    },
    ownerDecision(input) {
      const taskId = text(input.taskId, 'taskId', 32), offerId = text(input.offerId, 'offerId', 32);
      check(Number.isSafeInteger(input.offerVersion) && input.offerVersion > 0, 'Invalid offerVersion', 400);
      check(['approve','counter','later','stop'].includes(input.decision), 'Invalid decision', 400);
      input = { ...input, offerId };
      const time = Date.now();
      const call = all("SELECT * FROM actions WHERE task_id=? AND task_revision=(SELECT revision FROM tasks WHERE id=?) AND kind='owner_call' AND status IN ('done','in_flight')", taskId, taskId).find(a => {
        const p = parse(a.payload);
        return (p.attemptId || p.simulated === true) && p.dispatchedAt >= time - 30 * 60_000 && p.dispatchedAt <= time && p.offerId === offerId && p.offerVersion === input.offerVersion;
      });
      check(call, 'No owner call is in progress for these terms', 403);
      const t = task(taskId);
      try {
        return atomic(() => {
          check(!t.stopped, 'Task was stopped');
          const o = offerRow(offerId, input.offerVersion), latest = offerRow(offerId);
          check(o.task_id === taskId && o.task_revision === t.revision && o.validity === 'current' && o.version === latest.version, 'Offer is no longer current');
          if (input.decision === 'approve') db.approve(taskId, input, t.owner_phone, true);
          else if (input.decision === 'counter') db.counter(taskId, input);
          else if (input.decision === 'stop') db.stop(taskId);
          else event(taskId, 'owner_later', 'Owner will decide later on the link.');
          const current = task(taskId);
          if (['approve','counter'].includes(input.decision) && current.state === 'Blocked') return { ok: 'false', result: current.blocked_reason };
          const result = { approve: 'Approved. I will now ask the supplier to confirm.', counter: 'I will ask the supplier for a better offer.', later: 'You can decide later on your link.', stop: 'Stopped. Unsent work has been cancelled.' };
          return { ok: 'true', result: result[input.decision] };
        });
      } catch (error) { if (!error.status) throw error; return { ok: 'false', result: error.message }; }
    },
    contacts(taskId, input) {
      const t = task(taskId); allowed(t);
      check(['Needs you','Working','Blocked'].includes(t.state), 'Contacts cannot be changed during confirmation');
      const permit = list(input.permit || [], 'permit'), add = list(input.add || [], 'add'), names = [];
      for (const participantId of permit) {
        const p = get('SELECT * FROM participants WHERE id=? AND task_id=?', participantId, taskId);
        check(p, 'Unknown supplier', 400);
        run("UPDATE participants SET permitted=1,consent='Owner explicitly selected this supplier.' WHERE id=?", p.id);
        names.push(p.name);
      }
      for (const p of add) { const participantId = insertContact(taskId, p, 'owner', true); names.push(db.participant(participantId).name); }
      check(get('SELECT 1 FROM participants WHERE task_id=? AND permitted=1', taskId), 'Choose or add at least one supplier');
      if (names.length) event(taskId, 'contact_permission', `Owner gave permission to contact: ${[...new Set(names)].join(', ')}.`);
      state(taskId, 'Working'); plan(taskId);
      return { taskId, state: task(taskId).state };
    },
    identify(input) {
      const digits = lastTen(input.phone);
      if (digits.length !== 10) return { role: 'customer' };
      const cutoff = new Date(Date.now() - Number(config.TASK_TTL_HOURS || 24) * 3600_000).toISOString();
      const p = all(`SELECT p.* FROM participants p JOIN tasks t ON t.id=p.task_id
        WHERE t.stopped=0 AND t.state NOT IN ('Confirmed','Completed','Stopped') AND t.created_at>=?
        AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.task_id=t.id AND o.participant_id=p.id AND o.task_revision=t.revision AND o.validity='current')
        ORDER BY t.created_at DESC,t.rowid DESC,p.ordinal`, cutoff).find(p => lastTen(p.phone) === digits);
      if (!p) {
        // A returning customer hears only a state-level summary: caller ID is weak proof, so no prices or supplier details.
        const mine = all('SELECT id,owner_phone FROM tasks WHERE stopped=0 AND created_at>=? ORDER BY created_at DESC,rowid DESC', cutoff).find(r => lastTen(r.owner_phone) === digits);
        if (!mine) return { role: 'customer' };
        const o = task(mine.id), v = db.view(o.id), found = all("SELECT count(*) AS n FROM participants WHERE task_id=? AND source='research' AND permitted=0", o.id)[0].n;
        const open = get('SELECT q.text,p.name FROM questions q JOIN participants p ON p.id=q.participant_id WHERE q.task_id=? AND q.answer IS NULL ORDER BY q.created_at LIMIT 1', o.id);
        const next = get("SELECT due_at FROM actions WHERE task_id=? AND type='call' AND status='queued' ORDER BY due_at LIMIT 1", o.id);
        const offers = v.offers.filter(x => x.validity === 'current').length;
        const detail = o.state === 'Needs you' ? (open ? `${open.name} asked: ${open.text} Answer on your link.` : found ? `I found ${found} possible suppliers. Open your link to choose who I may call.` : offers ? `${offers} offer${offers > 1 ? 's are' : ' is'} in. Open your link to decide.` : 'Something needs your decision on your link.')
          : o.state === 'Working' ? `I am contacting suppliers.${next && next.due_at > Date.now() ? ` The next call is planned for ${new Date(next.due_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.` : ''}`
          : o.state === 'Blocked' ? `I am stuck: ${o.blocked_reason || 'no supplier could be reached'}`
          : o.state === 'Awaiting confirmation' ? 'You approved the terms and I am waiting for the supplier to confirm.'
          : o.state === 'Confirmed' ? 'The supplier accepted the arrangement.' : o.state === 'Completed' ? 'Your comparison is ready on your link.' : `Status: ${o.state}.`;
        const quotes = v.offers.filter(x => x.validity === 'current' && x.task_revision === o.revision).map(x => `${x.supplier}: ${x.total == null ? 'total not known yet' : `total ${x.total} rupees`}${x.terms.upfront ? `, ${x.terms.upfront} upfront` : ''}${x.suitable ? '' : ` (${x.reasons[0]})`}`);
        const contacted = all('SELECT DISTINCT p.name FROM call_attempts a JOIN participants p ON p.id=a.participant_id WHERE a.task_id=?', o.id).map(r => r.name);
        const details = [quotes.length ? `Quotes so far: ${quotes.join('; ')}.` : '', contacted.length ? `Suppliers contacted: ${contacted.join(', ')}.` : ''].filter(Boolean).join(' ');
        return { role: 'owner', ownerTaskId: o.id, status_summary: `Request: ${o.outcome} ${detail}${details ? ` Details, only if the caller asks: ${details}` : ''}`.slice(0, 1200) };
      }
      const t = task(p.task_id), attemptId = id(), key = `${t.id}:inbound:${attemptId}`;
      enqueue(t.id, 'inbound', key, { participantId: p.id });
      const action = get('SELECT id FROM actions WHERE action_key=?', key);
      db.finishAction(action.id);
      run('INSERT INTO call_attempts(id,task_id,task_revision,participant_id,action_id,provider,purpose,status,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', attemptId, t.id, t.revision, p.id, action.id, 'sarvam-inbound', 'collect_offer', 'connected', '{}', now());
      event(t.id, 'inbound', `${p.name} called Kairos back. Caller ID is not authority to make a commitment.`, { attemptId });
      const result = { role: 'supplier', taskId: t.id, attemptId, supplierName: p.name, request_summary: t.outcome, hard_requirements: json(t.hardConstraints), deadline: t.deadline || '', owner_answers: json(all('SELECT text,answer FROM questions WHERE task_id=? AND participant_id=? AND task_revision=? AND answer IS NOT NULL', t.id, p.id, t.revision)) };
      if (t.discloseBudget) result.budget_max = t.budgetMax === null ? '' : String(t.budgetMax);
      return result;
    },
    // Hard-deletes tasks older than the TTL with every row that references them. Events stay append-only while their task exists.
    purgeExpired(ttlHours) {
      const ids = all('SELECT id FROM tasks WHERE created_at < ?', new Date(Date.now() - ttlHours * 3600e3).toISOString()).map(r => r.id);
      if (!ids.length) return ids;
      const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name<>'tasks'").map(r => r.name).filter(n => all(`PRAGMA table_info(${n})`).some(c => c.name === 'task_id'));
      sql.exec('PRAGMA foreign_keys=OFF');
      try { for (const taskId of ids) { run('DELETE FROM tasks WHERE id=?', taskId); for (const t of tables) run(`DELETE FROM ${t} WHERE task_id=?`, taskId); } }
      finally { sql.exec('PRAGMA foreign_keys=ON'); }
      return ids;
    },
    bySubdomain: label => get('SELECT id FROM tasks WHERE subdomain=?', label)?.id,
    setLayout(taskId, layout) { run('UPDATE tasks SET layout=? WHERE id=?', json(layout), taskId); },
    createDraft(input) {
      check(['quote','appointment','reschedule'].includes(input.type), 'Invalid task type', 400);
      check(['information','arrangement'].includes(input.mode), 'Invalid completion mode', 400);
      const brief = { language: text(input.language || 'English', 'language', 100), type: input.type, mode: input.type === 'quote' ? 'information' : input.mode,
        outcome: text(input.outcome, 'outcome'), supplierKind: input.supplierKind ? text(input.supplierKind, 'supplierKind', 500) : null, location: input.location ? text(input.location, 'location', 500) : null, hardConstraints: list(input.hardConstraints || [], 'hardConstraints'), preferences: list(input.preferences || [], 'preferences'),
        deadline: input.deadline || null, timezone: text(input.timezone || 'Asia/Kolkata', 'timezone', 100), budgetMax: money(input.budgetMax, 'budgetMax'),
        discloseBudget: input.discloseBudget === true, mayCounter: input.mayCounter === true, unresolved: list(input.unresolved || [], 'unresolved') };
      if (brief.deadline) check(Number.isFinite(Date.parse(brief.deadline)), 'Deadline must be an ISO date/time', 400);
      const contacts = list(input.contacts || [], 'contacts');
      let arrangement = null;
      if (input.type === 'reschedule') {
        check(input.existingArrangement && input.existingArrangement.reference && input.existingArrangement.acceptedTerms, 'Rescheduling needs an existing arrangement reference and acceptedTerms', 400);
        arrangement = { reference: input.existingArrangement.reference, acceptedTerms: input.existingArrangement.acceptedTerms, amendmentStatus: 'not accepted', inForce: true };
      }
      const taskId = id();
      const slug = brief.outcome.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'task';
      run('INSERT INTO tasks(id,subdomain,owner_phone,brief,state,arrangement,simulated,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, `${slug}-${taskId.slice(0, 8)}`, phone(input.ownerPhone), json(brief), 'Draft', arrangement ? json(arrangement) : null, +!config.SARVAM_API_KEY, now(), now());
      contacts.filter((p, index) => contacts.findIndex(other => lastTen(other.phone) === lastTen(p.phone)) === index).forEach((p, index) => run('INSERT INTO participants(id,task_id,name,phone,ordinal,permitted,disclosures,consent) VALUES(?,?,?,?,?,1,?,?)', id(), taskId, text(p.name, 'contact name', 120), indianPhone(p.phone) || phone(p.phone), index, json({ budget: brief.discloseBudget }), 'Owner supplied this contact; permission becomes active on brief confirmation.'));
      event(taskId, 'draft', 'Draft created. No calls are authorised until you confirm the brief.');
      return { taskId };
    },
    confirmBrief(taskId) {
      const t = task(taskId);
      if (t.state !== 'Draft') return { taskId, state: t.state };
      check(!t.unresolved.length, 'Resolve every uncertain fact before confirming the brief');
      const hasContacts = get('SELECT 1 FROM participants WHERE task_id=? AND permitted=1', taskId);
      check(hasContacts || t.supplierKind, 'At least one permitted contact or supplierKind is required');
      if (!hasContacts) {
        state(taskId, 'Needs you'); event(taskId, 'brief_confirmed', 'Owner confirmed the brief. Supplier research does not authorise calls.');
        notify(taskId, `${taskId}:initial`, `Kairos: follow your task and respond securely here: ${link(t)}`);
        enqueue(taskId, 'research', `${taskId}:r${t.revision}:research`, {});
        return { taskId, state: 'Needs you', research: true };
      }
      state(taskId, 'Working'); event(taskId, 'brief_confirmed', 'Owner confirmed the brief and permission to contact the listed suppliers.');
      notify(taskId, `${taskId}:initial`, `Kairos: follow your task and respond securely here: ${link(t)}`);
      plan(taskId); return { taskId, state: task(taskId).state };
    },
    view(taskId) {
      const t = task(taskId);
      const offers = all('SELECT o.*,p.name AS supplier FROM offers o JOIN participants p ON p.id=o.participant_id WHERE o.task_id=? ORDER BY o.created_at,o.version', taskId).map(o => ({ ...o, terms: parse(o.terms), ...suitability(t, parse(o.terms), o.validity), canCounter: t.mayCounter && !t.stopped && o.validity === 'current' && !get("SELECT 1 FROM call_attempts WHERE task_id=? AND participant_id=? AND purpose='counter'", taskId, o.participant_id) }));
      const questions = all('SELECT q.*,p.name AS supplier FROM questions q JOIN participants p ON p.id=q.participant_id WHERE q.task_id=? ORDER BY q.created_at', taskId);
      const question = questions.find(q => q.task_revision === t.revision && q.answer === null);
      const currentOffers = offers.filter(o => o.validity === 'current' && o.task_revision === t.revision);
      let currentAction = { type: 'status', text: t.blocked_reason || ({ Draft: 'Confirm the brief with the intake agent to start.', Working: 'Contacting your permitted suppliers, one at a time.', 'Awaiting confirmation': 'Your exact terms are approved. Waiting for the supplier to accept.', 'Awaiting required action': 'A required condition remains. Review the outcome below.', Confirmed: 'The supplier accepted the arrangement. The service itself has not yet been delivered.', Completed: 'Your information is ready. No booking was made.', Stopped: 'Unsent work is stopped. An in-flight call or prior agreement may still need attention.', 'Needs reconciliation': 'An external response conflicts with current authority. Review the evidence with the supplier; no cancellation is claimed.' }[t.state] || 'Review your options.') };
      if (!t.stopped && t.state === 'Needs you') currentAction = question ? { type: 'question', question } : { type: 'approval', offers: currentOffers.filter(o => !approvalBlocker(o.terms, o)).map(o => ({ id: o.id, version: o.version })), text: 'Approving authorises Kairos to seek supplier acceptance of exactly these terms. It does not make a payment.' };
      const notifications = all('SELECT id,kind,status,provider_id,error,retry_status,created_at FROM notifications WHERE task_id=? AND kind<>? ORDER BY created_at', taskId, 'otp');
      const attempts = all('SELECT a.id,a.participant_id,a.purpose,a.status,a.duration,a.failure_reason,a.notes,a.created_at,p.name AS supplier FROM call_attempts a JOIN participants p ON p.id=a.participant_id WHERE a.task_id=? ORDER BY a.created_at', taskId).map(a => ({ ...a, notes: parse(a.notes) }));
      const contacts = all('SELECT id,name,phone,permitted,source,source_url,note FROM participants WHERE task_id=? ORDER BY ordinal', taskId).map(p => ({ ...p, phone: `••••${p.phone.slice(-4)}` }));
      const needsSuppliers = !contacts.length || contacts.some(p => p.source === 'research' && !p.permitted);
      if (!contacts.some(p => p.permitted) && t.state === 'Needs you') currentAction = { type: 'suppliers', text: 'Choose suppliers Kairos may call, or add a name and number.' };
      const { owner_phone, brief, arrangement, outcome_record, layout: storedLayout, ...publicTask } = t;
      const layout = storedLayout.filter(b => b.type !== 'suppliers');
      if (needsSuppliers) layout.splice(2, 0, { type: 'suppliers', props: {} });
      return { task: { ...publicTask, notifications, attempts, maskedPhone: `••••${owner_phone.slice(-4)}` }, layout, contacts, currentAction, offers, questions,
        events: all('SELECT * FROM events WHERE task_id=? ORDER BY id', taskId).map(e => ({ ...e, data: parse(e.data), simulated: !!e.simulated })), outcome: t.outcomeRecord,
        uploads: all('SELECT id,filename,content_type,size,created_at FROM uploads WHERE task_id=? ORDER BY created_at', taskId), simulated: t.simulated };
    },
    // Supplier asked to be called later; inbound requests can queue the callback immediately.
    callback(input) {
      const { a, t, p } = source(input);
      const minutes = Math.min(720, Math.max(1, Number(input.minutes) || 10)), at = Date.now() + minutes * 60_000;
      if (a.callback_at) return { callbackAt: new Date(a.callback_at).toISOString() };
      run('UPDATE call_attempts SET callback_at=? WHERE id=?', at, a.id);
      event(t.id, 'callback_requested', `${p.name} asked to be called back${input.when ? ` (${text(input.when, 'when', 200)})` : ''}. Kairos will call again in about ${minutes} minutes.`, { attemptId: a.id, callbackAt: at });
      if (a.provider === 'sarvam-inbound') { state(t.id, 'Working'); plan(t.id); }
      return { callbackAt: new Date(at).toISOString() };
    },
    question(input) {
      const { a, t, p } = source(input); const questionText = text(input.text, 'question');
      const existing = get('SELECT id FROM questions WHERE attempt_id=? AND text=?', a.id, questionText);
      if (existing) return { questionId: existing.id };
      const questionId = id(); state(t.id, 'Needs you');
      const eventId = event(t.id, 'question', `${p.name} asks: ${questionText}`, { attemptId: a.id, questionId });
      run('INSERT INTO questions(id,task_id,task_revision,participant_id,attempt_id,text,event_id,created_at) VALUES(?,?,?,?,?,?,?,?)', questionId, t.id, t.revision, p.id, a.id, questionText, eventId, now());
      notify(t.id, `${t.id}:question:${questionId}`, `Kairos: ${p.name} needs your answer. ${link(t)}`);
      return { questionId };
    },
    answer(taskId, input) {
      const t = task(taskId); allowed(t);
      const q = get('SELECT * FROM questions WHERE id=? AND task_id=? AND task_revision=?', input.questionId, taskId, t.revision);
      check(q, 'Question is no longer current');
      if (q.answer !== null) return { questionId: q.id, answer: q.answer };
      const answer = text(input.answer, 'answer');
      run('UPDATE questions SET answer=?,answered_at=? WHERE id=?', answer, now(), q.id);
      state(taskId, 'Working'); event(taskId, 'answer', `Owner answered: ${answer}`, { questionId: q.id }); plan(taskId);
      return { questionId: q.id, answer };
    },
    offer(input) {
      const { a, t, p } = source(input, true);
      check(input.spec && (typeof input.spec === 'string' || typeof input.spec === 'object'), 'Offer needs specification', 400);
      const terms = { spec: input.spec, availability: input.availability ?? null, deadline: input.deadline ?? null,
        basePrice: money(input.basePrice, 'basePrice'), fees: money(input.fees, 'fees'), taxes: money(input.taxes, 'taxes'),
        deposit: money(input.deposit, 'deposit'), upfront: money(input.upfront, 'upfront'), conditions: list(input.conditions || [], 'conditions'), unknown: list(input.unknown || [], 'unknown') };
      const prior = get('SELECT * FROM offers WHERE task_id=? AND participant_id=? ORDER BY version DESC LIMIT 1', t.id, p.id);
      if (prior && prior.terms === json(terms) && prior.task_revision === a.task_revision) return { offerId: prior.id, offerVersion: prior.version };
      const offerId = prior?.id || id(), version = (prior?.version || 0) + 1;
      const stale = a.task_revision !== t.revision || t.stopped || (!p.permitted && a.provider !== 'sarvam-inbound');
      const eventId = event(t.id, 'offer', `${p.name} supplied offer version ${version}${stale ? ' from an obsolete conversation; recheck required' : ''}.`, { offerId, version, attemptId: a.id });
      run('INSERT INTO offers(id,version,task_id,task_revision,participant_id,attempt_id,terms,validity,event_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', offerId, version, t.id, a.task_revision, p.id, a.id, json(terms), stale ? 'recheck' : 'current', eventId, now());
      if (!stale) {
        run('UPDATE tasks SET advice=NULL WHERE id=?', t.id);
        run('UPDATE call_attempts SET callback_done=1 WHERE task_id=? AND participant_id=? AND task_revision=?', t.id, p.id, t.revision);
        run("UPDATE actions SET status='cancelled',updated_at=? WHERE task_id=? AND type='call' AND status='queued' AND json_extract(payload,'$.participantId')=? AND json_extract(payload,'$.callbackOf') IS NOT NULL", now(), t.id, p.id);
      }
      // Cancel every queued confirmation for older versions; an already dispatched call must recheck authority.
      run("UPDATE actions SET status='cancelled',updated_at=? WHERE task_id=? AND type='call' AND status='queued' AND json_extract(payload,'$.purpose')='confirm' AND json_extract(payload,'$.offerId')=?", now(), t.id, offerId);
      if (!stale && !['Needs reconciliation','Draft'].includes(t.state)) {
        if (['Confirmed','Awaiting required action'].includes(t.state)) { state(t.id, 'Needs you'); event(t.id, 'changed_terms', 'Supplier changed terms after acceptance. The recorded agreement remains evidence; review this new version.'); }
        else state(t.id, 'Working');
        plan(t.id);
      }
      return { offerId, offerVersion: version, ...suitability(task(t.id), terms, stale ? 'recheck' : 'current') };
    },
    counter(taskId, input) {
      const t = task(taskId); allowed(t);
      const o = offerRow(input.offerId); check(o.task_id === taskId && o.task_revision === t.revision && o.validity === 'current', 'Offer is not current');
      check(t.state === 'Needs you', 'Wait for current calls to finish before requesting a counteroffer');
      queueCall(taskId, o.participant_id, 'counter', { offerId: o.id, offerVersion: o.version, counterAsk: t.advice?.counterOfferId === o.id ? t.advice.counterAsk : null });
      return { state: task(taskId).state };
    },
    approve(taskId, input, ownerPhone, byVoice = false) {
      const t = task(taskId); check(ownerPhone === t.owner_phone, 'Wrong owner', 403);
      const prior = get('SELECT * FROM approvals WHERE task_id=? AND task_revision=? AND offer_id=? AND offer_version=?', taskId, t.revision, input.offerId, input.offerVersion);
      if (prior) { check(prior.valid && db.authority(taskId, input.offerId, input.offerVersion).ok, 'This approval is no longer valid'); return { approvalId: prior.id }; }
      allowed(t); check(t.state === 'Needs you', 'An offer cannot be approved while another action is pending');
      check(t.type !== 'quote' && t.mode === 'arrangement', 'Information tasks do not require approval');
      const o = offerRow(input.offerId, input.offerVersion), latest = offerRow(input.offerId);
      check(o.task_id === taskId && o.version === latest.version && o.task_revision === t.revision && o.validity === 'current', 'Offer is no longer current');
      // The owner decides on budget and preferences, so warnings can be overridden by an explicit approval of exact terms.
      // Two things cannot: a price that is not fully known, and an upfront amount larger than the total.
      const fit = suitability(t, o.terms), blocker = approvalBlocker(o.terms, fit);
      check(!blocker, blocker);
      check(!get('SELECT 1 FROM questions WHERE task_id=? AND task_revision=? AND answer IS NULL', taskId, t.revision), 'Answer the pending question first');
      run('UPDATE approvals SET valid=0 WHERE task_id=?', taskId);
      const approvalId = id();
      run('INSERT INTO approvals(id,task_id,task_revision,offer_id,offer_version,owner_phone,terms,created_at) VALUES(?,?,?,?,?,?,?,?)', approvalId, taskId, t.revision, o.id, o.version, ownerPhone, json(o.terms), now());
      event(taskId, 'approved', `${byVoice ? "Approved by voice on Kairos's call to the owner." : `Owner approved exact offer version ${o.version}.`}${fit.suitable ? '' : ` Approved despite: ${fit.reasons.join(' ')}`}`, { approvalId, offerId: o.id, version: o.version, terms: o.terms, acknowledged: fit.reasons });
      queueCall(taskId, o.participant_id, 'confirm', { offerId: o.id, offerVersion: o.version, approvalId });
      return { approvalId };
    },
    authority(taskId, offerId, version) {
      const t = task(taskId);
      if (t.stopped) return { ok: false, reason: 'Task was stopped' };
      if (['Draft','Needs reconciliation','Blocked','Completed'].includes(t.state)) return { ok: false, reason: `Task is ${t.state}` };
      if (get('SELECT 1 FROM questions WHERE task_id=? AND task_revision=? AND answer IS NULL', taskId, t.revision)) return { ok: false, reason: 'A supplier question still needs an owner answer' };
      const o = get('SELECT * FROM offers WHERE id=? AND version=? AND task_id=?', offerId, Number(version), taskId);
      if (!o || o.task_revision !== t.revision || o.validity !== 'current' || get('SELECT 1 FROM offers WHERE id=? AND version>?', offerId, Number(version))) return { ok: false, reason: 'Offer version or request revision changed' };
      const p = get('SELECT permitted FROM participants WHERE id=?', o.participant_id);
      if (!p?.permitted) return { ok: false, reason: 'Contact permission was revoked' };
      const approval = get('SELECT * FROM approvals WHERE task_id=? AND task_revision=? AND offer_id=? AND offer_version=? AND valid=1', taskId, t.revision, offerId, Number(version));
      if (!approval || approval.owner_phone !== t.owner_phone || approval.terms !== o.terms) return { ok: false, reason: 'No valid owner approval for these exact terms' };
      return { ok: true, reason: 'Current owner approval matches these exact terms' };
    },
    acceptance(input) {
      const { a, t, p } = source(input, true);
      check(a.provider !== 'sarvam-inbound', 'Inbound caller ID is not authority: acceptance requires Kairos’s outbound confirmation call', 403);
      check(typeof input.accepted === 'boolean', 'accepted must be boolean', 400);
      const o = offerRow(input.offerId, input.offerVersion);
      check(o.task_id === t.id && o.participant_id === p.id, 'Acceptance source does not match offer supplier', 403);
      const conditions = list(input.conditions || [], 'conditions');
      const key = `${a.id}:${o.id}:${o.version}:${input.accepted}:${hash(json(conditions))}`;
      if (get("SELECT 1 FROM callback_events WHERE provider='acceptance' AND provider_attempt_id=?", key)) return { duplicate: true, state: t.state };
      run('INSERT INTO callback_events(provider,provider_attempt_id,task_id,payload,created_at) VALUES(?,?,?,?,?)', 'acceptance', key, t.id, json(input), now());
      const authority = db.authority(t.id, o.id, o.version);
      const evidence = { supplier: p.name, participantId: p.id, attemptId: a.id, offerId: o.id, offerVersion: o.version, terms: o.terms, accepted: input.accepted, conditions, at: now(), simulated: t.simulated };
      const eventId = event(t.id, 'supplier_response', `${p.name} ${input.accepted ? 'accepted' : 'did not accept'} offer version ${o.version}.`, evidence);
      evidence.eventId = eventId;
      if (!input.accepted) {
        if (!t.stopped && !['Needs reconciliation','Confirmed'].includes(t.state)) { state(t.id, 'Needs you'); run('UPDATE approvals SET valid=0 WHERE task_id=?', t.id); }
        return { state: task(t.id).state };
      }
      const callPayload = parse(a.payload);
      const sourceMatches = a.purpose === 'confirm' && callPayload.offerId === o.id && callPayload.offerVersion === o.version && a.task_revision === t.revision;
      if (!authority.ok || !sourceMatches) {
        state(t.id, 'Needs reconciliation');
        run('UPDATE approvals SET valid=0 WHERE task_id=?', t.id);
        run("UPDATE actions SET status='cancelled' WHERE task_id=? AND status='queued' AND type IN ('call','simulate')", t.id);
        event(t.id, 'reconciliation', 'Supplier acceptance conflicts with current authority. It is preserved as evidence; cancellation has not been confirmed.', { reason: authority.reason, evidence });
      } else {
        // Conditions already in the approved terms are part of what was agreed, not something outstanding.
        // Only a condition the supplier adds while accepting, or money due before the service, holds confirmation back.
        const agreed = new Set(o.terms.conditions.map(c => c.trim().toLowerCase()));
        const prerequisites = conditions.filter(c => !agreed.has(c.trim().toLowerCase()) && !/^(none|no|nil|nothing|no conditions?|all inclusive)\.?$/i.test(c.trim()));
        if (o.terms.deposit > 0) prerequisites.push(`Owner must pay mandatory deposit of ₹${o.terms.deposit}; payment has not been verified.`);
        if (o.terms.upfront > 0) prerequisites.push(`Owner must pay ₹${o.terms.upfront} upfront; payment has not been verified.`);
        state(t.id, prerequisites.length ? 'Awaiting required action' : 'Confirmed');
        run('UPDATE tasks SET outcome_record=? WHERE id=?', json({ ...evidence, prerequisites, responsiblePerson: prerequisites.length ? 'Owner; verify fulfilment with the supplier' : null, text: prerequisites.length ? 'Supplier acceptance has outstanding conditions.' : 'The arrangement was accepted. Service delivery is still pending.' }), t.id);
        if (t.type === 'reschedule' && !prerequisites.length) run('UPDATE tasks SET arrangement=? WHERE id=?', json({ ...t.existingArrangement, inForce: false, amendmentStatus: 'accepted', amendment: evidence }), t.id);
        event(t.id, prerequisites.length ? 'required_action' : 'confirmed', prerequisites.length ? prerequisites.join(' ') : 'Supplier accepted the current approved terms.');
      }
      notify(t.id, `${t.id}:acceptance:${eventId}`, `Kairos: ${task(t.id).state}. ${link(t)}`);
      return { state: task(t.id).state };
    },
    revise(taskId, changes) {
      const t = task(taskId); check(!t.stopped, 'A stopped task cannot be resumed; create a new task');
      check(changes && typeof changes === 'object' && !Array.isArray(changes) && Object.keys(changes).length, 'Provide changes', 400);
      const keys = ['outcome','hardConstraints','preferences','deadline','timezone','budgetMax','discloseBudget','mayCounter','unresolved','supplierKind','location'];
      check(Object.keys(changes).every(k => keys.includes(k)), 'Only request details and permissions can be revised', 400);
      const brief = { ...parse(t.brief), ...changes };
      for (const key of ['supplierKind','location']) if (brief[key] != null) text(brief[key], key, 500);
      text(brief.outcome, 'outcome'); text(brief.timezone, 'timezone'); money(brief.budgetMax, 'budgetMax');
      for (const key of ['hardConstraints','preferences','unresolved']) list(brief[key], key);
      check(typeof brief.mayCounter === 'boolean' && typeof brief.discloseBudget === 'boolean', 'Permissions must be booleans', 400);
      if (brief.deadline) check(Number.isFinite(Date.parse(brief.deadline)), 'Invalid deadline', 400);
      const nextState = t.state === 'Needs reconciliation' ? t.state : brief.unresolved.length ? 'Draft' : 'Working';
      run('UPDATE tasks SET brief=?,advice=NULL,revision=revision+1,state=?,blocked_reason=NULL,updated_at=? WHERE id=?', json(brief), nextState, now(), taskId);
      run("UPDATE actions SET status='cancelled' WHERE task_id=? AND (type='call' OR kind IN ('research','think','owner_call')) AND status='queued'", taskId);
      event(taskId, 'revised', `Request revised to revision ${t.revision + 1}. Existing offers need rechecking; previous approvals are invalid.`, { changes });
      plan(taskId); return { revision: t.revision + 1 };
    },
    // Owner asks to try unreached suppliers again: re-call every permitted contact that has no current offer, one after another.
    retry(taskId) {
      const t = task(taskId); allowed(t);
      check(['Blocked', 'Working'].includes(t.state), 'Calls can only be retried while the task is working or blocked');
      const rows = all(`SELECT a.* FROM call_attempts a WHERE a.task_id=? AND a.task_revision=? AND a.purpose='collect_offer'
        AND a.created_at=(SELECT max(created_at) FROM call_attempts WHERE task_id=a.task_id AND participant_id=a.participant_id)
        AND NOT EXISTS(SELECT 1 FROM offers o WHERE o.task_id=a.task_id AND o.participant_id=a.participant_id AND o.task_revision=a.task_revision)`, taskId, t.revision);
      check(rows.length, 'There is no supplier left to call again');
      for (const a of rows) run('UPDATE call_attempts SET callback_at=?,callback_done=0 WHERE id=?', Date.now(), a.id);
      run('UPDATE tasks SET state=?,blocked_reason=NULL,updated_at=? WHERE id=?', 'Working', now(), taskId);
      event(taskId, 'retry', 'Owner asked Kairos to call again.');
      plan(taskId); return { retried: rows.length };
    },
    stop(taskId) {
      const t = task(taskId); if (t.stopped) return { state: t.state };
      run("UPDATE tasks SET stopped=1,state='Stopped',updated_at=? WHERE id=?", now(), taskId);
      run("UPDATE actions SET status='cancelled' WHERE task_id=? AND status='queued' AND (type IN ('call','notify') OR kind IN ('research','think','owner_call'))", taskId);
      run("UPDATE notifications SET status='cancelled',error='Unsent notification stopped by owner' WHERE task_id=? AND status='queued'", taskId);
      event(taskId, 'stopped', 'Owner stopped unsent work. In-flight calls and previously accepted agreements are preserved; no cancellation is claimed.');
      return { state: 'Stopped' };
    },
    sarvamWebhook(payload) {
      check(payload && typeof payload.attempt_id === 'string' && ['connected','no_answer','busy','failed'].includes(payload.status), 'Invalid Sarvam completion', 400);
      if (get("SELECT 1 FROM callback_events WHERE provider='sarvam' AND provider_attempt_id=?", payload.attempt_id)) return { duplicate: true };
      const metadata = payload.webhook_config?.metadata;
      if (metadata?.kind === 'owner_call') {
        check(typeof metadata.taskId === 'string' && Number.isSafeInteger(Number(metadata.actionId)) && Number(metadata.actionId) > 0, 'Invalid owner call metadata', 400);
        const action = get("SELECT * FROM actions WHERE id=? AND task_id=? AND kind='owner_call' AND status IN ('in_flight','done','uncertain')", Number(metadata.actionId), metadata.taskId);
        const stored = action && parse(action.payload);
        check(stored?.dispatchedAt && !stored.simulated && (!stored.attemptId || stored.attemptId === payload.attempt_id), 'Webhook cannot be correlated to a dispatched owner call', 404);
        run('INSERT INTO callback_events(provider,provider_attempt_id,task_id,payload,created_at) VALUES(?,?,?,?,?)', 'sarvam', payload.attempt_id, action.task_id, json(payload), now());
        run('UPDATE actions SET payload=? WHERE id=?', json({ ...stored, attemptId: payload.attempt_id }), action.id);
        db.finishAction(action.id);
        event(action.task_id, 'owner_call_completed', payload.status === 'connected' ? 'Call to you: connected.' : "You did not answer Kairos's call; the decision is waiting on your link.");
        return { duplicate: false };
      }
      let a = get('SELECT * FROM call_attempts WHERE provider_attempt_id=?', payload.attempt_id);
      if (!a) {
        const metadata = payload.webhook_config?.metadata;
        if (metadata?.actionId) a = get('SELECT * FROM call_attempts WHERE action_id=? AND task_id=? AND participant_id=? AND provider_attempt_id IS NULL', Number(metadata.actionId), metadata.taskId, metadata.participantId);
      }
      check(a, 'Webhook cannot be correlated to a dispatched attempt', 404);
      run('INSERT INTO callback_events(provider,provider_attempt_id,task_id,payload,created_at) VALUES(?,?,?,?,?)', 'sarvam', payload.attempt_id, a.task_id, json(payload), now());
      run('UPDATE call_attempts SET provider_attempt_id=?,status=?,completed_at=?,duration=?,failure_reason=?,notes=? WHERE id=?', payload.attempt_id, payload.status, now(), typeof payload.duration === 'number' ? payload.duration : null, payload.failure_reason || null, json({ transcript: payload.interaction_transcript || [], finalAgentVariables: payload.final_agent_variables || {} }), a.id);
      run("UPDATE actions SET status='done',error=NULL,updated_at=? WHERE id=?", now(), a.action_id);
      event(a.task_id, 'call_completed', `${db.participant(a.participant_id).name}: call ${payload.status}${payload.failure_reason ? ` (${payload.failure_reason})` : ''}.`, { attemptId: a.id });
      // Not picking up is not a refusal: try that supplier once more shortly, within the per-task call cap.
      if (['no_answer', 'busy'].includes(payload.status) && a.purpose === 'collect_offer' && get('SELECT count(*) AS n FROM call_attempts WHERE task_id=? AND participant_id=? AND provider<>\'sarvam-inbound\'', a.task_id, a.participant_id).n < 2) {
        const at = Date.now() + Number(config.RETRY_MINUTES ?? 3) * 60_000;
        run('UPDATE call_attempts SET callback_at=? WHERE id=?', at, a.id);
        event(a.task_id, 'callback_requested', `${db.participant(a.participant_id).name} did not answer. Kairos will try once more in about ${Number(config.RETRY_MINUTES ?? 3)} minutes.`, { attemptId: a.id, callbackAt: at });
      }
      // Transcripts and final variables are evidence only; they never grant authority.
      const t = task(a.task_id);
      if (t.state === 'Blocked' && t.blocked_reason?.startsWith('Dispatch outcome unknown')) state(t.id, 'Working');
      if (a.purpose === 'confirm' && task(a.task_id).state === 'Awaiting confirmation') {
        block(a.task_id, 'Supplier acceptance was not recorded. Contact the supplier to reconcile this confirmation attempt before making another commitment.');
      } else plan(a.task_id);
      return { duplicate: false };
    },
    smsWebhook(payload) {
      check(['sms:delivered','sms:failed'].includes(payload?.event) && payload.payload?.messageId, 'Invalid SMS event', 400);
      const key = `${payload.payload.messageId}:${payload.event}:${payload.payload.phoneNumber || ''}`;
      if (get("SELECT 1 FROM callback_events WHERE provider='sms' AND provider_attempt_id=?", key)) return { duplicate: true };
      const notification = get('SELECT * FROM notifications WHERE provider_id=?', String(payload.payload.messageId));
      if (notification && payload.payload.phoneNumber) check(secretEqual(task(notification.task_id).owner_phone, payload.payload.phoneNumber), 'SMS recipient does not match', 400);
      run('INSERT INTO callback_events(provider,provider_attempt_id,task_id,payload,created_at) VALUES(?,?,?,?,?)', 'sms', key, notification?.task_id || null, json(payload), now());
      if (notification) applySmsReceipt(notification, payload);
      return { duplicate: false };
    },
    requestOtp(taskId) {
      const t = task(taskId), time = Date.now();
      let current = get('SELECT * FROM otps WHERE task_id=?', taskId);
      if (current && time - current.window_start >= 15 * 60_000) { run('DELETE FROM otps WHERE task_id=?', taskId); current = null; }
      check(!current || (current.attempts < 5 && current.sends < 5), 'Too many code attempts. Try again in 15 minutes.', 429);
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      run('INSERT INTO otps(task_id,code_hash,expires_at,window_start,sends) VALUES(?,?,?,?,1) ON CONFLICT(task_id) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,sends=otps.sends+1,used=0', taskId, hash(code), time + 10 * 60_000, time);
      notify(taskId, `${taskId}:otp:${id()}`, `Your Kairos code is ${code}. It expires in 10 minutes.`, 'otp');
      return { maskedPhone: `••••${t.owner_phone.slice(-4)}`, simulated: !config.SMS_GATEWAY_URL };
    },
    verifyOtp(taskId, code) {
      const t = task(taskId), otp = get('SELECT * FROM otps WHERE task_id=?', taskId);
      if (!otp || otp.used || otp.expires_at < Date.now() || otp.attempts >= 5) return { error: 'Code expired or too many attempts. Request a new code after the limit resets.', status: 429 };
      run('UPDATE otps SET attempts=attempts+1 WHERE task_id=?', taskId);
      if (!secretEqual(otp.code_hash, hash(String(code)))) return { error: 'Incorrect code', status: 401 };
      run('UPDATE otps SET used=1 WHERE task_id=?', taskId);
      const token = randomBytes(32).toString('hex');
      run('INSERT INTO sessions(token_hash,owner_phone,expires_at,created_at) VALUES(?,?,?,?)', hash(token), t.owner_phone, Date.now() + 7 * 86400_000, now());
      return { token };
    },
    authenticate(taskId, token) {
      if (!token) return null;
      const session = get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', hash(token), Date.now());
      return session && secretEqual(session.token_hash, hash(token)) && secretEqual(session.owner_phone, task(taskId).owner_phone) ? session.owner_phone : null;
    },
    addUpload(taskId, upload) {
      check(!task(taskId).stopped, 'Task is stopped');
      run('INSERT INTO uploads(id,task_id,filename,path,content_type,size,created_at) VALUES(?,?,?,?,?,?,?)', id(), taskId, upload.filename, upload.path, upload.contentType, upload.size, now());
      event(taskId, 'upload', `Owner uploaded ${upload.filename}. This records the file; delivery to the supplier must be arranged separately.`);
    },
    claim() {
      const action = get("SELECT * FROM actions WHERE status='queued' AND due_at<=? ORDER BY id LIMIT 1", Date.now());
      if (!action) return null;
      run("UPDATE actions SET status='in_flight',updated_at=? WHERE id=? AND status='queued'", now(), action.id);
      return { ...action, type: action.kind || action.type, payload: parse(action.payload) };
    },
    prepareCall(action) {
      const t = task(action.task_id), payload = action.payload;
      if (t.stopped || t.revision !== action.task_revision || ['Draft','Needs reconciliation','Blocked','Confirmed','Completed','Awaiting required action'].includes(t.state)) { db.finishAction(action.id, 'cancelled'); return null; }
      const p = get('SELECT * FROM participants WHERE id=? AND task_id=? AND permitted=1', payload.participantId, t.id);
      check(p, 'Contact permission is missing');
      const due = gatedTime(p, Date.now());
      if (due > Date.now()) {
        run("UPDATE actions SET status='queued',due_at=? WHERE id=?", due, action.id); gateEvent(t.id, p, due); plan(t.id); return null;
      }
      if (get(`SELECT 1 FROM call_attempts WHERE task_id=? AND provider<>'sarvam-inbound' AND status IN ${activeAttempt}`, t.id)) {
        run("UPDATE actions SET status='queued',due_at=? WHERE id=?", Date.now() + 1000, action.id); return null;
      }
      if (payload.purpose === 'confirm' && !db.authority(t.id, payload.offerId, payload.offerVersion).ok) { db.finishAction(action.id, 'cancelled'); state(t.id, 'Needs you'); return null; }
      if (payload.purpose === 'counter') check(t.mayCounter && !get("SELECT 1 FROM call_attempts WHERE task_id=? AND participant_id=? AND purpose='counter'", t.id, p.id), 'Counteroffer authority expired');
      if (get('SELECT count(*) AS n FROM call_attempts WHERE task_id=? AND provider<>\'sarvam-inbound\'', t.id).n >= maxAttempts) { db.finishAction(action.id, 'cancelled'); block(t.id, `The ${maxAttempts}-call limit is exhausted. Start a new task with confirmed details to continue.`); return null; }
      check(!get(`SELECT 1 FROM call_attempts WHERE task_id=? AND provider<>'sarvam-inbound' AND status IN ${activeAttempt}`, t.id), 'A call is already in flight');
      const attemptId = id();
      run('INSERT INTO call_attempts(id,task_id,task_revision,participant_id,action_id,provider,purpose,status,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', attemptId, t.id, t.revision, p.id, action.id, config.SARVAM_API_KEY ? 'sarvam' : 'simulated', payload.purpose, 'dispatching', json(payload), now());
      event(t.id, 'calling', `Calling ${p.name}.`, { attemptId, purpose: payload.purpose });
      // What already happened with this supplier, in plain words, so a later call does not start from zero.
      const earlier = all("SELECT status,purpose,callback_at,created_at FROM call_attempts WHERE task_id=? AND participant_id=? AND id<>? ORDER BY created_at", t.id, p.id, attemptId);
      const quoted = get('SELECT terms,version FROM offers WHERE task_id=? AND participant_id=? ORDER BY version DESC LIMIT 1', t.id, p.id);
      const asked = all('SELECT text,answer FROM questions WHERE task_id=? AND participant_id=? ORDER BY created_at', t.id, p.id);
      const lastSpoke = earlier.filter(e => e.status === 'connected').at(-1), qt = quoted && parse(quoted.terms);
      const history = [
        lastSpoke ? `You spoke to them ${Math.max(1, Math.round((Date.now() - Date.parse(lastSpoke.created_at)) / 60000))} minutes ago.` : earlier.length ? 'Earlier calls were not answered.' : '',
        earlier.some(e => e.callback_at) ? 'They asked to be called back.' : '',
        qt ? `They quoted: ${termsSentence(qt)}` : '',
        ...asked.map(q => `They asked: "${q.text}"${q.answer === null ? ' (customer has not answered yet).' : ` Customer's answer: "${q.answer}".`}`)
      ].filter(Boolean).join(' ');
      return { task: t, participant: p, purpose: payload.purpose, counterAsk: payload.counterAsk || null, attemptId, history, approvedSentence: payload.offerId ? termsSentence(offerRow(payload.offerId, payload.offerVersion).terms) : '', answers: all('SELECT text,answer FROM questions WHERE task_id=? AND participant_id=? AND task_revision=? AND answer IS NOT NULL', t.id, p.id, t.revision), offer: payload.offerId ? offerRow(payload.offerId, payload.offerVersion) : null };
    },
    saveVariables(attemptId, variables) { run('UPDATE call_attempts SET variables=? WHERE id=?', json(variables), attemptId); },
    dispatched(attemptId, result) {
      const a = attempt(attemptId);
      if (a.completed_at) return; // A provider callback can beat the dispatch response.
      run("UPDATE call_attempts SET provider_attempt_id=?,status='awaiting_callback' WHERE id=?", result.attemptId, a.id);
      db.finishAction(a.action_id, 'done');
      if (result.simulated) enqueue(a.task_id, 'simulate', `simulate:${a.id}`, { attemptId: a.id }, Date.now() + Number(config.SIM_DELAY_MS ?? 1500));
    },
    dispatchFailed(attemptId, error) {
      const a = attempt(attemptId);
      if (a.completed_at) return;
      const uncertain = error.uncertain || ['TimeoutError','AbortError','TypeError'].includes(error.name);
      run('UPDATE call_attempts SET status=?,failure_reason=? WHERE id=?', uncertain ? 'uncertain' : 'failed', error.message, a.id);
      db.finishAction(a.action_id, uncertain ? 'uncertain' : 'failed', error.message);
      event(a.task_id, 'call_dispatch_failed', uncertain ? 'Dispatch outcome unknown. No automatic retry will be made.' : `Call dispatch failed: ${error.message}`, { attemptId });
      const t = task(a.task_id);
      if (!t.stopped && !['Needs reconciliation','Confirmed'].includes(t.state)) {
        if (uncertain) block(a.task_id, 'Dispatch outcome unknown. Reconcile this attempt with the provider or wait for its correlated completion webhook before continuing.');
        else if (a.purpose === 'confirm') block(a.task_id, 'Confirmation call failed. Verify supplier status before trying a new task.');
        else plan(a.task_id);
      }
    },
    notification(actionKey) { return get('SELECT * FROM notifications WHERE action_key=?', actionKey); },
    notificationResult(action, result) {
      run('UPDATE notifications SET status=?,provider_id=?,response=?,error=? WHERE action_key=?', result.status, result.messageId, json(result.response), result.error || null, action.action_key);
      db.finishAction(action.id, result.status === 'uncertain' ? 'uncertain' : result.status === 'failed' ? 'failed' : 'done', result.error || null);
      if (result.messageId) for (const receipt of all("SELECT payload FROM callback_events WHERE provider='sms' AND json_extract(payload,'$.payload.messageId')=? ORDER BY id", result.messageId)) applySmsReceipt(db.notification(action.action_key), parse(receipt.payload));
      if (db.notification(action.action_key).kind !== 'otp') event(action.task_id, 'notification', `SMS ${db.notification(action.action_key).status.replaceAll('_', ' ')}.`, { notificationId: db.notification(action.action_key).id });
    },
    finishAction(actionId, status = 'done', error = null) { run('UPDATE actions SET status=?,error=?,updated_at=? WHERE id=?', status, error, now(), actionId); },
    uncertainAction(action, reason) {
      db.finishAction(action.id, 'uncertain', reason);
      if (action.kind === 'owner_call' || action.type === 'owner_call') return;
      if (action.type === 'notify') run("UPDATE notifications SET status='uncertain',error=? WHERE action_key=?", reason, action.action_key);
      else {
        const payload = typeof action.payload === 'string' ? parse(action.payload) : action.payload;
        if (action.type === 'simulate') run("UPDATE call_attempts SET status='uncertain' WHERE id=? AND completed_at IS NULL", payload.attemptId);
        else run("UPDATE call_attempts SET status='uncertain' WHERE action_id=? AND completed_at IS NULL", action.id);
        const t = task(action.task_id);
        if (!t.stopped && !['Confirmed','Needs reconciliation','Completed'].includes(t.state)) block(t.id, `Dispatch outcome unknown. ${reason}. Reconcile with the provider before another call.`);
      }
    },
    recover() {
      const pending = all("SELECT * FROM actions WHERE status='in_flight'");
      for (const action of pending) {
        if (['research','think'].includes(action.kind)) run("UPDATE actions SET status='queued' WHERE id=?", action.id);
        else db.uncertainAction(action, 'Process ended while action was in flight');
      }
      for (const t of all("SELECT id FROM tasks WHERE state IN ('Working','Needs you') AND stopped=0")) plan(t.id);
    }
  };
  function applySmsReceipt(notification, payload) {
    if (payload.payload.phoneNumber && !secretEqual(task(notification.task_id).owner_phone, payload.payload.phoneNumber)) return;
    if (notification.status === 'delivered') return;
    const delivered = payload.event === 'sms:delivered';
    run('UPDATE notifications SET status=?,error=? WHERE id=?', delivered ? 'delivered' : 'failed', delivered ? null : `Phone reported SMS failure${payload.payload.reason ? `: ${String(payload.payload.reason).slice(0, 200)}` : ''}`, notification.id);
  }
  for (const name of ['researchResult','adviceResult','prepareOwnerCall','ownerCallDispatched','ownerCallFailed','contacts','identify','setLayout','createDraft','confirmBrief','callback','retry','question','answer','offer','counter','approve','acceptance','revise','stop','sarvamWebhook','smsWebhook','requestOtp','verifyOtp','addUpload','claim','prepareCall','saveVariables','dispatched','dispatchFailed','notificationResult','finishAction','uncertainAction','recover']) {
    const fn = db[name]; db[name] = (...args) => atomic(() => fn(...args));
  }
  return db;
}
