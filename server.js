const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Token: SOLO da variabili d'ambiente (Railway -> Variables), mai scritti qui nel codice
// (questo file finisce su GitHub). Senza configurarli il bot parte comunque, ma rifiuta
// sia la verifica webhook di Meta sia le richieste di polling del gestionale.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const POLL_SECRET  = process.env.POLL_SECRET  || null;

if (!VERIFY_TOKEN) console.warn('⚠️  VERIFY_TOKEN non impostato su Railway: la verifica webhook di Meta fallira\'.');
if (!POLL_SECRET)  console.warn('⚠️  POLL_SECRET non impostato su Railway: il gestionale non potra\' prelevare i messaggi.');

// Coda dei messaggi ricevuti, in memoria: il gestionale la svuota periodicamente
// interrogando GET /messages. Tenuta limitata a MAX_QUEUE per non crescere all'infinito
// se per qualche motivo il gestionale smette di interrogarla.
const MAX_QUEUE = 1000;
let messageQueue = [];
let nextId = 1;

// 1. Endpoint per la VERIFICA del Webhook (Richiesta GET di Meta)
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('✅ WEBHOOK VERIFICATO CON SUCCESSO DA META!');
            res.status(200).send(challenge);
        } else {
            console.log('❌ Fallimento verifica: Token errato');
            res.sendStatus(403);
        }
    }
});

// 2. Endpoint per RICEVERE i messaggi WhatsApp (Richiesta POST di Meta)
app.post('/webhook', (req, res) => {
    let body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
            let from = body.entry[0].changes[0].value.messages[0].from; // Chi ti scrive
            let msg_body = body.entry[0].changes[0].value.messages[0].text?.body || '(messaggio non testuale)';

            console.log(`📩 Nuovo messaggio da ${from}: "${msg_body}"`);

            messageQueue.push({
                id: nextId++,
                from,
                text: msg_body,
                timestamp: new Date().toISOString()
            });
            if (messageQueue.length > MAX_QUEUE) {
                messageQueue = messageQueue.slice(messageQueue.length - MAX_QUEUE);
            }
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

// 3. Endpoint interrogato dal gestionale per prelevare i messaggi nuovi.
// "after" = ID dell'ultimo messaggio gia' importato: restituisce solo quelli successivi,
// cosi' un giro di polling in ritardo o fallito non perde nulla (li richiede al giro dopo).
app.get('/messages', (req, res) => {
    if (req.query.key !== POLL_SECRET) return res.sendStatus(403);
    const afterId = parseInt(req.query.after, 10) || 0;
    const batch = messageQueue.filter(m => m.id > afterId);
    res.json({ messages: batch });
});

// Usa la porta fornita dall'ambiente (necessario per Railway) o 3000 in locale
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
