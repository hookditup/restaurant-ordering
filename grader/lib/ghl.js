// Sends a grader lead to the Hook'd IT Up GHL account. The "grader-lead" tag starts the workflow
// (a standard Contact Tag Added trigger, so no per-use webhook charge).
const API = 'https://services.leadconnectorhq.com';
const FIELDS = { score: 'gMQigDlYqbjZnPVxZUs6', url: 'NTgBQYTWofnah7rfl1is', restaurant: 'Lbf3cyP2QV2lRNxRDBSX' };

export async function sendLead(lead, env = process.env) {
  if (!env.GHL_TOKEN || !env.GHL_LOCATION_ID) return { ok: false, skipped: 'GHL is not connected yet.' };
  const [firstName, ...rest] = lead.name.split(/\s+/);
  const body = {
    locationId: env.GHL_LOCATION_ID,
    firstName, lastName: rest.join(' '),
    email: lead.email,
    ...(lead.phone ? { phone: lead.phone } : {}),
    companyName: lead.restaurant,
    ...(lead.website ? { website: lead.website } : {}),
    source: 'Restaurant Grader — grader.hookditup.com',
    tags: ['grader-lead', ...(lead.smsConsent ? ['grader-sms-consent'] : [])],
    customFields: [
      { id: FIELDS.score, field_value: lead.score },
      { id: FIELDS.url, field_value: lead.reportUrl },
      { id: FIELDS.restaurant, field_value: lead.restaurant },
    ],
  };
  const r = await fetch(`${API}/contacts/upsert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `GHL ${r.status}: ${d?.message || 'error'}` };
  return { ok: true, contactId: d.contact?.id };
}
