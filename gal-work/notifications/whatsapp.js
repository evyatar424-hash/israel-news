const https = require('https');

async function sendWhatsApp(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
  const to = process.env.WHATSAPP_TO;            // e.g. 'whatsapp:+972501234567'

  if (!sid || !token || !from || !to) {
    console.warn('WhatsApp env vars missing, skipping notification');
    return;
  }

  const body = new URLSearchParams({ From: from, To: to, Body: message }).toString();
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${sid}/Messages.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.sid) console.log('WhatsApp sent:', json.sid);
          else console.error('WhatsApp error:', json);
          resolve(json);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error('WhatsApp request failed:', e); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { sendWhatsApp };
