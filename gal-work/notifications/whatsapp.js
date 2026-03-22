const https = require('https');

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM        = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const TO          = process.env.WHATSAPP_TO;

function sendWhatsApp(message) {
  return new Promise((resolve, reject) => {
    if (!ACCOUNT_SID || !AUTH_TOKEN || !TO) {
      console.warn('WhatsApp env vars not set, skipping notification');
      console.log('Message:', message);
      return resolve();
    }

    const body = new URLSearchParams({
      From: FROM,
      To: `whatsapp:${TO}`,
      Body: message,
    }).toString();

    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64'),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('WhatsApp sent successfully');
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Twilio error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendWhatsApp };
