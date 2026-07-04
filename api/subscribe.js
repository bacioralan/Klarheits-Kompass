// ============================================================
//  /api/subscribe  —  Vercel Serverless Function (Node 18+)
// ============================================================
// Nimmt die Daten aus dem Klarheits-Kompass-Tool entgegen und legt den
// Kontakt in systeme.io an (bzw. aktualisiert ihn) + setzt drei Custom
// Fields und einen Tag. Der API-Key liegt ausschliesslich serverseitig
// in der Umgebungsvariable SYSTEME_API_KEY und wird NIE an den Browser
// ausgeliefert.
//
// Benoetigte Environment-Variablen in Vercel:
//   SYSTEME_API_KEY   (Pflicht)  dein systeme.io Public-API-Key
//   SYSTEME_TAG_NAME  (optional) Tag-Name, Default: "Leadmagnet Rad des Lebens"
//   ALLOWED_ORIGIN    (optional) erlaubte Origin fuer CORS, Default: "*"
// ============================================================

const API_BASE = 'https://api.systeme.io/api';

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function sioFetch(path, options) {
  const key = process.env.SYSTEME_API_KEY;
  const opts = options || {};
  const headers = Object.assign(
    {
      'X-API-Key': key,
      'Accept': 'application/json'
    },
    opts.headers || {}
  );
  const res = await fetch(API_BASE + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, ok: res.ok, data };
}

function isValidEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// Kontakt anlegen; wenn er schon existiert, per E-Mail suchen und Felder patchen.
async function upsertContact(email, firstName, fields) {
  // 1. Anlegen versuchen (firstName = systeme.io-Standardfeld fuer Personalisierung)
  const create = await sioFetch('/contacts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(firstName ? { email, firstName, fields } : { email, fields })
  });

  if (create.ok && create.data && create.data.id) {
    return { id: create.data.id, created: true };
  }

  // 2. Existiert bereits (typisch 422 / 400) -> per E-Mail finden
  const search = await sioFetch('/contacts?email=' + encodeURIComponent(email));
  const items = (search.data && (search.data.items || search.data)) || [];
  const found = Array.isArray(items)
    ? items.find(function (c) { return c && c.email && c.email.toLowerCase() === email.toLowerCase(); }) || items[0]
    : null;

  if (!found || !found.id) {
    // weder anlegen noch finden -> Fehler nach oben geben
    const err = new Error('Kontakt konnte nicht angelegt oder gefunden werden.');
    err.detail = { create: create.status, createBody: create.data, search: search.status };
    throw err;
  }

  // 3. Felder aktualisieren (merge-patch)
  await sioFetch('/contacts/' + found.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/merge-patch+json' },
    body: JSON.stringify(firstName ? { firstName, fields } : { fields })
  });

  return { id: found.id, created: false };
}

// Tag-ID zum Namen finden; falls nicht vorhanden, anlegen.
async function resolveTagId(name) {
  const list = await sioFetch('/tags');
  const items = (list.data && (list.data.items || list.data)) || [];
  if (Array.isArray(items)) {
    const hit = items.find(function (t) {
      return t && t.name && t.name.toLowerCase() === name.toLowerCase();
    });
    if (hit && hit.id) return hit.id;
  }
  const created = await sioFetch('/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  return created.data && created.data.id ? created.data.id : null;
}

async function assignTag(contactId, tagId) {
  if (!tagId) return;
  await sioFetch('/contacts/' + contactId + '/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tagId: tagId })
  });
}

module.exports = async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  cors(res, origin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  if (!process.env.SYSTEME_API_KEY) {
    res.status(500).json({ error: 'SYSTEME_API_KEY ist nicht gesetzt.' });
    return;
  }

  // Body robust einlesen (Vercel parst JSON meist schon, sonst manuell)
  let body = req.body;
  if (!body || typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch (_) { body = {}; }
  }

  const email = (body.email || '').trim();
  const firstName = (body.firstName || '').trim();
  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Ungueltige E-Mail-Adresse.' });
    return;
  }

  // Der Vorname wird als Standard-Kontaktfeld mit dem Slug "first_name" gesetzt.
  // Das ist der zuverlaessige Weg: Ein Top-Level "firstName" wird von der
  // systeme.io-API ignoriert (deshalb kam der Name bisher nicht in der
  // Kontaktkarte an). "first_name" ist ein eingebautes Standardfeld und
  // existiert in jedem Account.
  //
  // Custom Fields -> muessen in systeme.io unter Kontakte als Felder mit
  // exakt diesen Slugs existieren.
  const fields = [];
  if (firstName) fields.push({ slug: 'first_name', value: firstName });
  fields.push({ slug: 'kompass_grundtyp', value: String(body.grundtyp || '') });
  fields.push({ slug: 'kompass_schwaechste_bereiche', value: String(body.schwaechste_bereiche || '') });
  fields.push({ slug: 'kompass_durchschnitt', value: String(body.durchschnitt || '') });

  const tagName = process.env.SYSTEME_TAG_NAME || 'Leadmagnet Rad des Lebens';

  try {
    const contact = await upsertContact(email, firstName, fields);
    let tagId = null;
    try {
      tagId = await resolveTagId(tagName);
      await assignTag(contact.id, tagId);
    } catch (tagErr) {
      // Tag ist nice-to-have; Kontakt ist wichtiger. Nicht hart failen.
      console.error('Tag konnte nicht gesetzt werden:', tagErr && tagErr.message);
    }
    res.status(200).json({ ok: true, contactId: contact.id, created: contact.created, tagId });
  } catch (err) {
    console.error('subscribe error:', err && err.message, err && err.detail);
    res.status(502).json({ error: 'Kontakt konnte nicht gespeichert werden.' });
  }
};
