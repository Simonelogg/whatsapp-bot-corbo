const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

// Token: SOLO da variabili d'ambiente (Railway -> Variables), mai scritti nel codice.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || null;
const POLL_SECRET  = process.env.POLL_SECRET  || null;

if (!VERIFY_TOKEN) console.warn('⚠️  VERIFY_TOKEN non impostato su Railway: la verifica webhook di Meta fallira\'.');
if (!POLL_SECRET)  console.warn('⚠️  POLL_SECRET non impostato su Railway: il gestionale non potra\' prelevare i messaggi.');

// Directory di memorizzazione persistente:
// Su Railway usa la cartella montata del volume (/app/data se presente), altrimenti ./data locale.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'inbox.json');

const MAX_QUEUE = 2000;
let messageQueue = [];
let nextId = 1;
const bootTime = new Date().toISOString();

// Carica lo stato memorizzato all'avvio
function loadState() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            if (data && Array.isArray(data.messageQueue)) {
                messageQueue = data.messageQueue;
                nextId = typeof data.nextId === 'number' ? data.nextId : (messageQueue.length ? Math.max(...messageQueue.map(m => m.id || 0)) + 1 : 1);
                console.log(`📦 Caricati ${messageQueue.length} messaggi da persistenza (prossimo ID: ${nextId}).`);
                return;
            }
        }
    } catch (err) {
        console.error('⚠️  Errore nel caricamento dello stato da disco:', err.message);
    }
    messageQueue = [];
    nextId = 1;
}

// Salva lo stato su disco in modo sicuro (con file temporaneo atomico)
function saveState() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const tmpFile = `${DATA_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify({ nextId, messageQueue }, null, 2), 'utf8');
        fs.renameSync(tmpFile, DATA_FILE);
    } catch (err) {
        console.error('⚠️  Errore nel salvataggio su disco:', err.message);
    }
}

// Inizializza i dati all'avvio
loadState();

// 0. Endpoint di salute e monitoraggio
app.get('/health', (req, res) => {
    const currentMaxId = messageQueue.length ? Math.max(...messageQueue.map(m => m.id)) : 0;
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        bootTime,
        queueLength: messageQueue.length,
        maxId: currentMaxId,
        storageDir: DATA_DIR
    });
});

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
            console.log('❌ Fallimento verifica webhook: Token errato');
            res.sendStatus(403);
        }
    } else {
        res.sendStatus(400);
    }
});

// 2. Endpoint per RICEVERE i messaggi WhatsApp (Richiesta POST di Meta)
app.post('/webhook', (req, res) => {
    let body = req.body;

    if (!body || !body.object) {
        return res.sendStatus(404);
    }

    try {
        const entries = body.entry || [];
        let addedCount = 0;

        for (const entry of entries) {
            const changes = entry.changes || [];
            for (const change of changes) {
                const val = change.value;
                if (!val || !val.messages || !Array.isArray(val.messages)) continue;

                // Nome profilo mittente se fornito da Meta
                const profileName = val.contacts?.[0]?.profile?.name || null;

                for (const msg of val.messages) {
                    const wamid = msg.id; // ID globale univoco Meta (es: wamid.HBg...)
                    const from = msg.from;
                    const type = msg.type || 'text';

                    // Deduplica se Meta ritrasmette lo stesso messaggio
                    if (wamid && messageQueue.some(m => m.wamid === wamid)) {
                        console.log(`ℹ️ Messaggio duplicato ignorato (wamid: ${wamid})`);
                        continue;
                    }

                    // Estrazione testo e metadati multimediali
                    let msgText = '';
                    let mediaId = null;
                    let mediaType = null;
                    let mimeType = null;
                    let isVoice = false;

                    if (type === 'text') {
                        msgText = msg.text?.body || '';
                    } else if (type === 'button') {
                        msgText = msg.button?.text || '';
                    } else if (type === 'interactive') {
                        msgText = msg.interactive?.button_reply?.title 
                               || msg.interactive?.list_reply?.title 
                               || '';
                    } else if (type === 'audio') {
                        mediaId = msg.audio?.id || null;
                        mediaType = 'audio';
                        mimeType = msg.audio?.mime_type || 'audio/ogg';
                        isVoice = Boolean(msg.audio?.voice);
                        msgText = isVoice ? '🎤 [Messaggio vocale]' : '🎵 [Allegato audio]';
                    } else if (['image', 'video', 'document', 'sticker'].includes(type)) {
                        const mediaObj = msg[type] || {};
                        mediaId = mediaObj.id || null;
                        mediaType = type;
                        mimeType = mediaObj.mime_type || null;
                        const detail = mediaObj.caption ? `: ${mediaObj.caption}` : (mediaObj.filename ? `: ${mediaObj.filename}` : '');
                        msgText = `[Allegato ${type}${detail}]`;
                    } else {
                        msgText = '(messaggio non testuale)';
                    }

                    // Timestamp originale di invio dal paziente
                    let msgTimestamp;
                    if (msg.timestamp) {
                        const tsNum = parseInt(msg.timestamp, 10);
                        msgTimestamp = (!isNaN(tsNum) && tsNum > 0) ? new Date(tsNum * 1000).toISOString() : new Date().toISOString();
                    } else {
                        msgTimestamp = new Date().toISOString();
                    }

                    console.log(`📩 [${type}] da ${from} (${profileName || 'paziente'}): "${msgText}"${mediaId ? ` [media: ${mediaId}]` : ''}`);

                    messageQueue.push({
                        id: nextId++,
                        wamid: wamid || null,
                        from,
                        senderName: profileName,
                        type,
                        text: msgText,
                        mediaId,
                        mediaType,
                        mimeType,
                        isVoice,
                        timestamp: msgTimestamp
                    });
                    addedCount++;
                }
            }
        }

        if (addedCount > 0) {
            if (messageQueue.length > MAX_QUEUE) {
                messageQueue = messageQueue.slice(messageQueue.length - MAX_QUEUE);
            }
            saveState();
        }
    } catch (err) {
        console.error('❌ Errore elaborazione webhook Meta:', err);
    }

    res.sendStatus(200);
});

// 3. Endpoint interrogato dal gestionale per prelevare i messaggi nuovi.
// "after" = ID dell'ultimo messaggio già importato.
app.get('/messages', (req, res) => {
    if (req.query.key !== POLL_SECRET) return res.sendStatus(403);

    const afterId = parseInt(req.query.after, 10) || 0;
    const currentMaxId = messageQueue.length ? Math.max(...messageQueue.map(m => m.id)) : 0;

    // Resync se il gestionale chiede un ID superiore al massimo attualmente in coda
    if (afterId > 0 && afterId > currentMaxId && messageQueue.length > 0) {
        console.warn(`⚠️ Richiesta after=${afterId} superiore a maxId attuale (${currentMaxId}): invio resync.`);
        return res.json({
            messages: messageQueue,
            reset: true,
            maxId: currentMaxId,
            bootTime
        });
    }

    const batch = messageQueue.filter(m => m.id > afterId);
    res.json({
        messages: batch,
        reset: false,
        maxId: currentMaxId,
        bootTime
    });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`🚀 Server in ascolto sulla porta ${PORT} (dati in ${DATA_DIR})`));

// Gestione arresto pulito (SIGTERM inviato da Railway nei redeploy)
function gracefulShutdown(signal) {
    console.log(`🛑 Segnale ${signal} ricevuto: salvataggio coda e chiusura pulita...`);
    try {
        saveQueueToDisk();
    } catch (e) {
        console.error('Errore salvataggio durante shutdown:', e.message);
    }
    server.close(() => {
        console.log('✅ Server HTTP chiuso con successo.');
        process.exit(0);
    });
    setTimeout(() => {
        console.warn('⚠️ Timeout shutdown forzato (3s).');
        process.exit(0);
    }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error('❌ Errore non catturato (uncaughtException):', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Promise rejection non gestita:', reason);
});

