const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Inserisci qui la tua password inventata. 
// Dovrai scrivere ESATTAMENTE questa nella dashboard di Meta ("Verifica il token")
const VERIFY_TOKEN = 'T@kenSuperSegretissim@1999'; 

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
            let msg_body = body.entry[0].changes[0].value.messages[0].text.body; // Testo del msg

            console.log(`📩 Nuovo messaggio da ${from}: "${msg_body}"`);
        }
        res.sendStatus(200); 
    } else {
        res.sendStatus(404);
    }
});

// Usa la porta fornita dall'ambiente (necessario per Railway) o 3000 in locale
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT}`));
