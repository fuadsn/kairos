export async function send(to, text, actionKey, config = process.env) {
  if (!config.SMS_GATEWAY_URL) {
    console.log(`[Simulated SMS ${actionKey}] ${text}`);
    return { status: 'simulated', response: { simulated: true }, messageId: null };
  }
  try {
    const response = await fetch(`${config.SMS_GATEWAY_URL.replace(/\/$/, '')}/message`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${config.SMS_GATEWAY_USER || ''}:${config.SMS_GATEWAY_PASS || ''}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ textMessage: { text }, phoneNumbers: [to], withDeliveryReport: true }),
      signal: AbortSignal.timeout(10_000)
    });
    const raw = await response.text();
    let body; try { body = JSON.parse(raw); } catch { body = { raw }; }
    return { status: response.ok ? 'handed_to_phone' : 'failed', response: body, messageId: body?.id == null ? null : String(body.id), error: response.ok ? null : `SMS gateway returned HTTP ${response.status}` };
  } catch (error) {
    return { status: ['TimeoutError', 'AbortError'].includes(error.name) ? 'uncertain' : 'failed', response: null, messageId: null, error: error.message };
  }
}

// The phone accepts a message before it tries to send it, so ask again shortly after for the real outcome.
export async function status(messageId, config = process.env) {
  try {
    const r = await fetch(`${config.SMS_GATEWAY_URL.replace(/\/$/, '')}/message/${encodeURIComponent(messageId)}`, { headers: { Authorization: `Basic ${Buffer.from(`${config.SMS_GATEWAY_USER || ''}:${config.SMS_GATEWAY_PASS || ''}`).toString('base64')}` }, signal: AbortSignal.timeout(5000) });
    const m = await r.json(), rec = m.recipients?.[0] || {};
    return { state: m.state, phoneNumber: rec.phoneNumber, reason: rec.error };
  } catch { return {}; }
}
