// Modulo Anamnesi Digitale su Railway (Centro Dentale Corbo)
// Gestisce la creazione di sessioni con token univoco, la pagina web pubblica per il paziente,
// l'acquisizione della firma grafometrica touch e la sincronizzazione con il gestionale locale.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { calcolaCodiceFiscale, validaCF } = require('./cf');

// Anagrafiche per la registrazione da smartphone (stessi dati del gestionale):
// comuni {d: nome, p: provincia, b: codice Belfiore, c: CAP} e stati esteri.
let COMUNI = [], PAESI = [];
try { COMUNI = JSON.parse(fs.readFileSync(path.join(__dirname, 'comuni.json'), 'utf8')); } catch (e) { console.warn('⚠️ comuni.json non caricato:', e.message); }
try { PAESI = JSON.parse(fs.readFileSync(path.join(__dirname, 'paesi_esteri.json'), 'utf8')); } catch (e) { console.warn('⚠️ paesi_esteri.json non caricato:', e.message); }

const REGISTRAZIONE_VALIDITA_MS = 10 * 60 * 1000;       // un link di registrazione va APERTO entro 10 minuti dalla creazione
const REGISTRAZIONE_TOLLERANZA_MS = 30 * 60 * 1000;    // chi lo ha aperto in tempo ha 30 minuti per finire la compilazione
const REGISTRAZIONE_HTML = path.join(__dirname, 'registrazione.html');

function cercaPerPrefisso(lista, q, nomeKey) {
    const qq = (q || '').trim().toLowerCase();
    if (qq.length < 2) return [];
    return lista.filter(x => x[nomeKey].toLowerCase().startsWith(qq))
        .sort((a, b) => {
            const an = a[nomeKey].toLowerCase(), bn = b[nomeKey].toLowerCase();
            if ((an === qq) !== (bn === qq)) return an === qq ? -1 : 1;
            if (an.length !== bn.length) return an.length - bn.length;
            return an.localeCompare(bn);
        }).slice(0, 15);
}

function setupAnamnesiRoutes(app, { DATA_DIR, POLL_SECRET }) {
    const ANAMNESI_FILE = path.join(DATA_DIR, 'anamnesi.json');
    let sessions = {};

    function loadAnamnesiState() {
        try {
            if (fs.existsSync(ANAMNESI_FILE)) {
                const raw = fs.readFileSync(ANAMNESI_FILE, 'utf8');
                const data = JSON.parse(raw);
                if (data && typeof data.sessions === 'object') {
                    sessions = data.sessions;
                    console.log(`📋 [Anamnesi] Caricate ${Object.keys(sessions).length} sessioni da persistenza.`);
                    return;
                }
            }
        } catch (err) {
            console.error('⚠️ [Anamnesi] Errore nel caricamento delle sessioni da disco:', err.message);
        }
        sessions = {};
    }

    function saveAnamnesiState() {
        try {
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            const tmpFile = `${ANAMNESI_FILE}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify({ sessions }, null, 2), 'utf8');
            fs.renameSync(tmpFile, ANAMNESI_FILE);
        } catch (err) {
            console.error('⚠️ [Anamnesi] Errore nel salvataggio su disco:', err.message);
        }
    }

    loadAnamnesiState();

    // ─────────────────────────────────────────────────────────────────────────────
    // 1. ENDPOINT GESTIONALE: Creazione nuova sessione anamnesi con token
    // ─────────────────────────────────────────────────────────────────────────────
    app.post('/anamnesi/sessions', (req, res) => {
        const key = req.query.key || req.headers['x-poll-secret'];
        if (key !== POLL_SECRET) return res.status(403).json({ error: 'Non autorizzato' });

        const {
            token: customToken,
            tipo,
            idContatto,
            nome,
            cognome,
            dataNascita,
            codiceFiscale,
            telefono,
            email,
            questions,
            critici,
            textFields,
            note
        } = req.body;

        const isRegistrazione = tipo === 'registrazione';
        if (!isRegistrazione && (!nome || !cognome)) {
            return res.status(400).json({ error: 'Nome e cognome obbligatori' });
        }

        const token = customToken || crypto.randomBytes(20).toString('hex');
        const session = {
            token,
            tipo: isRegistrazione ? 'registrazione' : 'anamnesi',
            expiresAt: isRegistrazione ? new Date(Date.now() + REGISTRAZIONE_VALIDITA_MS).toISOString() : null,
            idContatto: idContatto || null,
            nome: (nome || '').trim(),
            cognome: (cognome || '').trim(),
            dataNascita: dataNascita || null,
            codiceFiscale: (codiceFiscale || '').trim().toUpperCase(),
            telefono: (telefono || '').trim(),
            email: (email || '').trim(),
            questions: Array.isArray(questions) ? questions : [],
            critici: critici || {},
            textFields: textFields || {},
            note: note || '',
            status: 'pending', // 'pending' | 'completed' | 'cancelled'
            createdAt: new Date().toISOString(),
            completedAt: null,
            acknowledged: false,
            datiCompilati: null
        };

        // Pulizia: i link di registrazione scaduti e mai completati non servono piu'
        const ora = Date.now();
        Object.keys(sessions).forEach(k => {
            const x = sessions[k];
            if (x.tipo === 'registrazione' && x.status === 'pending' && !sessioneRegistrazioneAperta(k)
                && ora > new Date(x.expiresAt).getTime() + REGISTRAZIONE_TOLLERANZA_MS) delete sessions[k];
        });

        sessions[token] = session;
        saveAnamnesiState();

        const host = req.get('host');
        const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
        const url = `${protocol}://${host}/anamnesi/${token}`;

        console.log(`📋 [Anamnesi] Creata sessione token ${token} per ${cognome} ${nome} (ID: ${idContatto})`);
        res.json({ success: true, token, url, session });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 2. ENDPOINT GESTIONALE: Preleva le anamnesi completate per scaricarle in locale
    // ─────────────────────────────────────────────────────────────────────────────
    app.get('/anamnesi/completed', (req, res) => {
        const key = req.query.key || req.headers['x-poll-secret'];
        if (key !== POLL_SECRET) return res.status(403).json({ error: 'Non autorizzato' });

        const completed = Object.values(sessions).filter(s => s.status === 'completed' && !s.acknowledged);
        res.json({ completed });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 3. ENDPOINT GESTIONALE: Conferma salvataggio nel DB locale (ACK)
    // ─────────────────────────────────────────────────────────────────────────────
    app.post('/anamnesi/ack', (req, res) => {
        const key = req.query.key || req.headers['x-poll-secret'];
        if (key !== POLL_SECRET) return res.status(403).json({ error: 'Non autorizzato' });

        const tokens = req.body.tokens;
        if (!Array.isArray(tokens)) return res.status(400).json({ error: 'tokens array obbligatorio' });

        let ackCount = 0;
        tokens.forEach(tok => {
            if (sessions[tok]) {
                sessions[tok].acknowledged = true;
                // Registrazione da smartphone: i dati personali e sanitari sono ormai nel gestionale
                // dello studio, non devono restare su questo server (privacy/GDPR).
                if (sessions[tok].tipo === 'registrazione') { delete sessions[tok]; ackCount++; return; }
                ackCount++;
            }
        });

        if (ackCount > 0) saveAnamnesiState();
        res.json({ success: true, acknowledgedCount: ackCount });
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 4. ENDPOINT PUBBLICO: Visualizza la pagina web di anamnesi per il paziente
    // ─────────────────────────────────────────────────────────────────────────────
    // Ricerche di supporto al modulo di registrazione (comuni, stati esteri, calcolo CF):
    // valide solo con un link di registrazione ancora aperto.
    function sessioneRegistrazioneAperta(token) {
        const s = sessions[token];
        if (!s || s.tipo !== 'registrazione' || s.status !== 'pending') return null;
        const adesso = Date.now();
        if (s.expiresAt && new Date(s.expiresAt).getTime() >= adesso) return s;            // ancora nei 10 minuti
        if (s.openedAt && adesso <= new Date(s.openedAt).getTime() + REGISTRAZIONE_TOLLERANZA_MS) return s; // aperto in tempo: puo' finire
        return null;
    }
    app.get('/anamnesi/:token/comuni', (req, res) => {
        if (!sessioneRegistrazioneAperta(req.params.token)) return res.status(404).json({ error: 'Link non valido o scaduto' });
        res.json(cercaPerPrefisso(COMUNI, req.query.search, 'd').map(c => ({ denominazione: c.d, provincia: c.p, codiceBelfiore: c.b, cap: c.c })));
    });
    app.get('/anamnesi/:token/paesi', (req, res) => {
        if (!sessioneRegistrazioneAperta(req.params.token)) return res.status(404).json({ error: 'Link non valido o scaduto' });
        res.json(cercaPerPrefisso(PAESI, req.query.search, 'denominazione').map(p => ({ denominazione: p.denominazione, codiceBelfiore: p.codice_belfiore })));
    });
    app.get('/anamnesi/:token/cf', (req, res) => {
        if (!sessioneRegistrazioneAperta(req.params.token)) return res.status(404).json({ error: 'Link non valido o scaduto' });
        try {
            const { cognome, nome, sesso, dataNascita, codiceBelfiore } = req.query;
            res.json({ codiceFiscale: calcolaCodiceFiscale({ cognome, nome, sesso, dataNascita, codiceBelfiore }) });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.get('/anamnesi/:token', (req, res) => {
        const token = req.params.token;
        const session = sessions[token];

        // Risposta JSON se richiesta da API (mai per le registrazioni: contengono dati personali e il link non e' una API)
        if (req.headers.accept && req.headers.accept.includes('application/json')) {
            if (!session || session.tipo === 'registrazione') return res.status(404).json({ error: 'Sessione non trovata' });
            return res.json(session);
        }

        // Registrazione da smartphone: il link e' valido solo per il tempo previsto e una sola volta.
        // Scaduto, usato o chiuso: sempre la stessa risposta, senza rivelare nulla sul paziente.
        if (session && session.tipo === 'registrazione' && (session.status !== 'pending' || !sessioneRegistrazioneAperta(token))) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            return res.status(410).send(renderErrorPage(
                'Link non più valido',
                'Il link per la registrazione è valido solo per pochi minuti e una sola volta. Per favore contatti la segreteria del Centro Dentale Corbo per riceverne uno nuovo.'
            ));
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');

        if (!session) {
            return res.status(404).send(renderErrorPage(
                'Link non valido o scaduto',
                'Il link per l\'anamnesi digitale non è stato trovato o è scaduto. Per favore contatti la segreteria del Centro Dentale Corbo per richiederne uno nuovo.'
            ));
        }

        if (session.status === 'completed') {
            const dataFmt = session.completedAt ? new Date(session.completedAt).toLocaleString('it-IT') : '';
            return res.send(renderSuccessPage(session, dataFmt, true));
        }

        if (session.tipo === 'registrazione') {
            res.setHeader('Cache-Control', 'no-store');
            if (!session.openedAt) { session.openedAt = new Date().toISOString(); saveAnamnesiState(); }
            // dati iniettati nella pagina: '<' escluso per evitare chiusure anticipate dello <script>
            const inietta = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
            const html = fs.readFileSync(REGISTRAZIONE_HTML, 'utf8')
                .replace('__TOKEN__', () => inietta(token))
                .replace('__QUESTIONS__', () => inietta(session.questions || []));
            return res.send(html);
        }

        res.send(renderFormPage(session));
    });

    // ─────────────────────────────────────────────────────────────────────────────
    // 5. ENDPOINT PUBBLICO: Riceve la compilazione e la firma del paziente
    // ─────────────────────────────────────────────────────────────────────────────
    app.post('/anamnesi/:token', (req, res) => {
        const token = req.params.token;
        const session = sessions[token];

        if (!session) {
            return res.status(404).json({ error: 'Sessione non trovata o scaduta' });
        }

        if (session.status === 'completed') {
            return res.status(400).json({ error: 'Anamnesi già inviata e registrata in precedenza' });
        }

        if (session.tipo === 'registrazione') {
            if (!sessioneRegistrazioneAperta(token)) return res.status(410).json({ error: 'Link scaduto: contatti la segreteria.' });
            const b = req.body || {};
            const a = b.anagrafica || {};
            const cognome = String(a.cognome || '').trim(), nome = String(a.nome || '').trim();
            const cf = String(a.cf || '').trim().toUpperCase();
            const sesso = parseInt(a.sesso, 10);
            const err = (m) => res.status(400).json({ error: m });
            if (!cognome || !nome) return err('Cognome e nome sono obbligatori.');
            if (sesso !== 0 && sesso !== 1) return err('Indicare il sesso.');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.dataNascita || ''))) return err('Data di nascita non valida.');
            const nascita = new Date(a.dataNascita + 'T00:00:00Z');
            if (isNaN(nascita) || nascita > new Date() || nascita.getUTCFullYear() < 1900) return err('Data di nascita non valida.');
            if (!String(a.luogoNascita || '').trim() || !a.codiceBelfiore) return err('Indicare il luogo di nascita.');
            if (!String(a.cellulare || '').trim()) return err('Il numero di cellulare è obbligatorio.');
            const oggi = new Date();
            let eta = oggi.getUTCFullYear() - nascita.getUTCFullYear();
            if (oggi.getUTCMonth() < nascita.getUTCMonth() || (oggi.getUTCMonth() === nascita.getUTCMonth() && oggi.getUTCDate() < nascita.getUTCDate())) eta--;
            if (eta < 18 && !String(a.genitore || '').trim()) return err('Paziente minorenne: indicare nome e cognome del genitore o tutore.');
            const cfErr = validaCF({ cf, cognome, nome, sesso, dataNascita: a.dataNascita, codiceBelfiore: String(a.codiceBelfiore) });
            if (cfErr) return err(cfErr);
            if (!b.consenso) return err('È necessario accettare il consenso al trattamento dei dati.');
            if (typeof b.firmaData !== 'string' || !b.firmaData.startsWith('data:image/png;base64,') || b.firmaData.length > 3000000) return err('Firma grafica obbligatoria.');

            const crit = b.critici || {}, txt = b.textFields || {};
            if (typeof crit.anestesiaDentista !== 'boolean') return err('Indicare se ha mai fatto anestesia dal dentista (SÌ o NO).');
            const adesso = new Date().toISOString();
            session.status = 'completed';
            session.completedAt = adesso;
            session.acknowledged = false;
            session.datiCompilati = {
                anagrafica: {
                    cognome, nome, cf, sesso, dataNascita: a.dataNascita,
                    luogoNascita: String(a.luogoNascita).trim(), codiceBelfiore: String(a.codiceBelfiore),
                    genitore: String(a.genitore || '').trim(),
                    indirizzo: String(a.indirizzo || '').trim(), civico: String(a.civico || '').trim(), cap: String(a.cap || '').trim(),
                    citta: String(a.citta || '').trim(), provincia: String(a.provincia || '').trim().toUpperCase(),
                    cellulare: String(a.cellulare).trim(), email: String(a.email || '').trim()
                },
                answers: Array.isArray(b.answers) ? b.answers.map(Number).filter(Boolean) : [],
                critici: {
                    allergiaAnestetico: !!crit.allergiaAnestetico,
                    allergiaAnesteticoSpecifica: String(crit.allergiaAnesteticoSpecifica || '').trim(),
                    allergiaFarmaci: !!crit.allergiaFarmaci,
                    allergiaFarmaciSpecifica: String(crit.allergiaFarmaciSpecifica || '').trim(),
                    allergiaLattice: !!crit.allergiaLattice,
                    portatorePacemaker: !!crit.portatorePacemaker,
                    anestesiaDentista: crit.anestesiaDentista
                },
                textFields: {
                    farmaciPrescritti: String(txt.farmaciPrescritti || '').trim(),
                    altreMalattie: String(txt.altreMalattie || '').trim()
                },
                firmaData: b.firmaData,
                consensoPrivacy: true,
                dataFirma: adesso,
                ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
                userAgent: req.headers['user-agent']
            };
            saveAnamnesiState();
            console.log(`✅ [Registrazione] Ricevuta registrazione da smartphone (token ${token})`);
            return res.json({ success: true, message: 'Registrazione acquisita con successo' });
        }

        const {
            answers,
            critici,
            textFields,
            noteAggiuntive,
            firmaData,
            consensoPrivacy
        } = req.body;

        if (!firmaData || !firmaData.startsWith('data:image/')) {
            return res.status(400).json({ error: 'La firma grafica è obbligatoria' });
        }

        if (!consensoPrivacy) {
            return res.status(400).json({ error: 'Il consenso al trattamento dei dati sanitari è obbligatorio' });
        }

        if (typeof critici?.anestesiaDentista !== 'boolean') {
            return res.status(400).json({ error: 'Indicare se ha mai fatto anestesia dal dentista (SÌ o NO).' });
        }

        const now = new Date().toISOString();
        session.status = 'completed';
        session.completedAt = now;
        session.acknowledged = false;
        session.datiCompilati = {
            answers: Array.isArray(answers) ? answers.map(Number) : [],
            critici: {
                allergiaAnestetico: !!critici?.allergiaAnestetico,
                allergiaAnesteticoSpecifica: (critici?.allergiaAnesteticoSpecifica || '').trim(),
                allergiaLattice: !!critici?.allergiaLattice,
                portatorePacemaker: !!critici?.portatorePacemaker,
                anestesiaDentista: critici.anestesiaDentista
            },
            textFields: {
                malattieCardio: (textFields?.malattieCardio || '').trim(),
                malattieInfettive: (textFields?.malattieInfettive || '').trim(),
                altreMalattie: (textFields?.altreMalattie || '').trim(),
                protesi: (textFields?.protesi || '').trim(),
                farmaciPrescritti: (textFields?.farmaciPrescritti || '').trim(),
                valoriPressori: (textFields?.valoriPressori || '').trim()
            },
            noteAggiuntive: (noteAggiuntive || '').trim(),
            firmaData: firmaData,
            consensoPrivacy: true,
            dataFirma: now,
            ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
            userAgent: req.headers['user-agent']
        };

        saveAnamnesiState();
        console.log(`✅ [Anamnesi] Ricevuta e firmata anamnesi per ${session.cognome} ${session.nome} (Token: ${token})`);
        res.json({ success: true, message: 'Anamnesi acquisita con successo' });
    });

    return {
        saveAnamnesiState
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE HTML: Pagina di errore
// ─────────────────────────────────────────────────────────────────────────────
function renderErrorPage(titolo, messaggio) {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titolo} – Centro Dentale Corbo</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
body { font-family: 'Inter', -apple-system, sans-serif; background: #f8fafc; color: #1e293b; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
.card { background: #fff; max-width: 480px; width: 100%; border-radius: 16px; padding: 32px 24px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0; }
.icon { font-size: 48px; color: #ef4444; margin-bottom: 16px; }
h1 { font-size: 20px; color: #0f172a; margin: 0 0 12px; }
p { font-size: 14px; color: #64748b; line-height: 1.6; margin: 0 0 24px; }
.btn { display: inline-block; background: #0d47a1; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
    <div class="icon"><i class="fa-solid fa-circle-exclamation"></i></div>
    <h1>${titolo}</h1>
    <p>${messaggio}</p>
    <a href="tel:+390922830880" class="btn"><i class="fa-solid fa-phone"></i> Chiama lo Studio</a>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE HTML: Pagina di successo
// ─────────────────────────────────────────────────────────────────────────────
function renderSuccessPage(session, dataFmt, giaInviata = false) {
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anamnesi Registrata – Centro Dentale Corbo</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
body { font-family: 'Inter', -apple-system, sans-serif; background: #f0fdf4; color: #1e293b; margin: 0; padding: 20px; display: flex; align-items: center; justify-content: center; min-height: 100vh; box-sizing: border-box; }
.card { background: #fff; max-width: 520px; width: 100%; border-radius: 18px; padding: 36px 26px; text-align: center; box-shadow: 0 12px 30px rgba(16,185,129,0.12); border: 1.5px solid #a7f3d0; }
.icon { width: 72px; height: 72px; background: #dcfce7; color: #10b981; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 36px; margin: 0 auto 20px; }
h1 { font-size: 22px; color: #065f46; margin: 0 0 10px; font-weight: 700; }
p { font-size: 14.5px; color: #475569; line-height: 1.6; margin: 0 0 18px; }
.patient-badge { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; margin-bottom: 22px; font-size: 13.5px; color: #1e293b; }
.patient-badge strong { color: #0d47a1; }
.time { font-size: 12.5px; color: #64748b; margin-top: 4px; }
.footer-text { font-size: 12px; color: #94a3b8; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
</style>
</head>
<body>
<div class="card">
    <div class="icon"><i class="fa-solid fa-circle-check"></i></div>
    <h1>${giaInviata ? 'Anamnesi già registrata' : 'Anamnesi inviata con successo!'}</h1>
    <div class="patient-badge">
        ${session.cognome || session.nome ? `Paziente: <strong>${session.cognome} ${session.nome}</strong>` : 'Registrazione ricevuta'}
        ${dataFmt ? `<div class="time"><i class="fa-solid fa-clock"></i> Acquisita e firmata il ${dataFmt}</div>` : ''}
    </div>
    <p>Il suo questionario sanitario e la sua firma sono stati archiviati in sicurezza nella cartella clinica del <strong>Centro Dentale Corbo</strong>.</p>
    <p style="font-size:13px; color:#64748b;">Grazie per la collaborazione. Può chiudere tranquillamente questa schermata.</p>
    <div class="footer-text">Centro Dentale Corbo • Via Falcone Borsellino, Canicattì (AG)</div>
</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE HTML: Form di compilazione anamnesi per il paziente (Mobile & Tablet)
// ─────────────────────────────────────────────────────────────────────────────
function renderFormPage(session) {
    const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const fmtDate = d => {
        if (!d) return '—';
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return d;
        return dt.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    const questions = session.questions || [];

    // Categorizza domande
    const catCondizioni = questions.filter(q => q.ID >= 1 && q.ID <= 8);
    const catFarmaci    = questions.filter(q => q.ID >= 9 && q.ID <= 17);
    const catAllergie   = questions.filter(q => (q.ID >= 18 && q.ID <= 21) || (q.ID >= 41 && q.ID <= 47));
    const catVaccini    = questions.filter(q => q.ID >= 22 && q.ID <= 34);
    const catAbitudini  = questions.filter(q => q.ID >= 35 && q.ID <= 39);
    const catAltro      = questions.filter(q => !catCondizioni.includes(q) && !catFarmaci.includes(q) && !catAllergie.includes(q) && !catVaccini.includes(q) && !catAbitudini.includes(q));

    function renderQuestionList(list) {
        if (!list.length) return '';
        return list.map(q => `
            <div class="q-card" data-id="${q.ID}">
                <div class="q-label">${esc(q.Descrizione)}</div>
                <div class="q-toggle-wrap">
                    <button type="button" class="btn-toggle no active" data-val="no">NO</button>
                    <button type="button" class="btn-toggle yes" data-val="yes">SÌ</button>
                </div>
            </div>
        `).join('');
    }

    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Anamnesi Clinica – Centro Dentale Corbo</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
:root {
    --primary: #0d47a1;
    --primary-light: #1e88e5;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --bg: #f8fafc;
    --card: #ffffff;
    --text: #1e293b;
    --text-muted: #64748b;
    --border: #e2e8f0;
    --radius: 12px;
}
* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; -webkit-tap-highlight-color: transparent; }
body { background: var(--bg); color: var(--text); padding-bottom: 60px; line-height: 1.5; font-size: 14px; }

/* Header */
.top-nav { background: #fff; border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 50; padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
.top-nav img { height: 38px; object-fit: contain; }
.top-badge { background: #e0f2fe; color: #0369a1; font-weight: 700; font-size: 11.5px; padding: 4px 10px; border-radius: 20px; display: flex; align-items: center; gap: 5px; }

/* Container */
.container { max-width: 680px; margin: 18px auto; padding: 0 16px; }

/* Intro card */
.hero-card { background: linear-gradient(135deg, #0d47a1 0%, #1e88e5 100%); color: #fff; border-radius: var(--radius); padding: 22px 20px; margin-bottom: 18px; box-shadow: 0 6px 18px rgba(13, 71, 161, 0.15); }
.hero-card h1 { font-size: 18px; font-weight: 800; margin-bottom: 4px; }
.hero-card p { font-size: 13px; opacity: 0.9; margin-bottom: 12px; }
.patient-pill { display: inline-flex; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.18); backdrop-filter: blur(4px); padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; }

/* Section cards */
.section-card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 18px; margin-bottom: 18px; box-shadow: 0 2px 8px rgba(0,0,0,0.03); }
.section-title { font-size: 15px; font-weight: 700; color: #0f172a; margin-bottom: 14px; display: flex; align-items: center; gap: 8px; }
.section-title i { color: var(--primary-light); }
.section-desc { font-size: 12.5px; color: var(--text-muted); margin-top: -8px; margin-bottom: 14px; }

/* Critical alerts card */
.section-card.critical { border-color: #fcd34d; background: #fffdf5; }
.section-card.critical .section-title { color: #b45309; }
.section-card.critical .section-title i { color: #f59e0b; }

/* Question item with SÌ / NO toggle */
.q-card { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 10px; background: #f8fafc; border: 1px solid #f1f5f9; margin-bottom: 8px; transition: all 0.2s ease; }
.q-card.is-yes { background: #ecfdf5; border-color: #a7f3d0; }
.q-card.mancante { background: #fffbeb; border-color: #f59e0b; }
.q-label { font-size: 13.5px; font-weight: 500; color: #334155; flex: 1; }
.q-toggle-wrap { display: flex; background: #e2e8f0; border-radius: 8px; padding: 2px; gap: 2px; flex-shrink: 0; }
.btn-toggle { border: none; background: transparent; padding: 6px 14px; font-size: 12.5px; font-weight: 700; border-radius: 6px; cursor: pointer; color: #64748b; transition: all 0.15s ease; }
.btn-toggle.no.active { background: #fff; color: #475569; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.btn-toggle.yes.active { background: var(--success); color: #fff; box-shadow: 0 1px 3px rgba(16,185,129,0.3); }

/* Form inputs */
.form-group { margin-bottom: 14px; }
.form-group label { display: block; font-size: 12.5px; font-weight: 600; color: #475569; margin-bottom: 5px; }
.form-control { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; font-family: inherit; color: var(--text); transition: border 0.2s; }
.form-control:focus { outline: none; border-color: var(--primary); }
textarea.form-control { resize: vertical; min-height: 70px; }

/* Signature Pad */
.signature-box { border: 2px dashed #cbd5e1; border-radius: 10px; background: #fafafa; padding: 6px; position: relative; margin-top: 8px; touch-action: none; }
.signature-box.has-signature { border-color: var(--primary-light); background: #fff; }
#signature-canvas { width: 100%; height: 160px; display: block; background: #fff; border-radius: 6px; cursor: crosshair; touch-action: none; }
.sig-hint { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #94a3b8; font-size: 13px; font-weight: 500; pointer-events: none; display: flex; align-items: center; gap: 6px; }
.sig-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.btn-clear-sig { background: #fff; border: 1px solid #cbd5e1; color: #64748b; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 5px; }
.btn-clear-sig:hover { background: #f1f5f9; color: var(--danger); }

/* Consent checkbox */
.consent-box { display: flex; align-items: flex-start; gap: 10px; background: #f1f5f9; border-radius: 8px; padding: 12px 14px; margin-top: 14px; font-size: 12.5px; line-height: 1.5; color: #475569; }
.consent-box input[type="checkbox"] { width: 18px; height: 18px; margin-top: 2px; accent-color: var(--primary); flex-shrink: 0; cursor: pointer; }

/* Submit Button */
.submit-btn-wrap { margin-top: 24px; }
.btn-submit { width: 100%; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; padding: 16px; border-radius: var(--radius); font-size: 16px; font-weight: 800; letter-spacing: 0.3px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 14px rgba(16,185,129,0.35); transition: all 0.2s; }
.btn-submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(16,185,129,0.45); }
.btn-submit:disabled { opacity: 0.6; cursor: not-allowed; }

/* Alert banner */
.form-alert { padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; margin-bottom: 14px; display: none; }
.form-alert.error { background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; display: block; }
</style>
</head>
<body>

<div class="top-nav">
    <img src="https://www.centrodentalecorbo.it/wp-content/uploads/2021/08/logo-definitivo-450.png" alt="Centro Dentale Corbo">
    <div class="top-badge"><i class="fa-solid fa-shield-halved"></i> Modulo Sicuro</div>
</div>

<div class="container">
    <div class="hero-card">
        <h1>Questionario di Anamnesi Clinica</h1>
        <p>Gentile paziente, la invitiamo a compilare questo questionario medico per garantire la massima sicurezza ed efficacia durante le cure odontoiatriche.</p>
        <div class="patient-pill">
            <i class="fa-solid fa-user"></i> ${esc(session.cognome)} ${esc(session.nome)}
            ${session.dataNascita ? ` • Nato il ${fmtDate(session.dataNascita)}` : ''}
        </div>
    </div>

    <form id="anamnesi-form">
        <div id="form-error" class="form-alert"></div>

        <!-- SEZIONE 1: AVVISI CLINICI CRITICI -->
        <div class="section-card critical">
            <div class="section-title"><i class="fa-solid fa-triangle-exclamation"></i> Avvisi Clinici Fondamentali</div>
            <div class="section-desc">Informazioni indispensabili prima dell'eventuale somministrazione di anestesia locale o manovre chirurgiche.</div>
            
            <div class="q-card" id="card-crit-anestetico">
                <div class="q-label">Ha mai manifestato allergie a <strong>farmaci anestetici locali</strong>?</div>
                <div class="q-toggle-wrap">
                    <button type="button" class="btn-toggle no active" data-val="no">NO</button>
                    <button type="button" class="btn-toggle yes" data-val="yes">SÌ</button>
                </div>
            </div>
            <div class="form-group" id="group-anestetico-spec" style="display:none; margin-top:8px; padding-left: 6px;">
                <label for="anestetico-specifica">Specificare l'anestetico o la reazione avuta:</label>
                <input type="text" id="anestetico-specifica" class="form-control" placeholder="es. lidocaina, tachicardia, gonfiore...">
            </div>

            <div class="q-card" id="card-crit-lattice">
                <div class="q-label">Ha allergia nota al <strong>lattice</strong> (guanti, diga, elastici)?</div>
                <div class="q-toggle-wrap">
                    <button type="button" class="btn-toggle no active" data-val="no">NO</button>
                    <button type="button" class="btn-toggle yes" data-val="yes">SÌ</button>
                </div>
            </div>

            <div class="q-card" id="card-crit-pacemaker">
                <div class="q-label">È portatore di <strong>pacemaker o defibrillatore</strong> cardiaco?</div>
                <div class="q-toggle-wrap">
                    <button type="button" class="btn-toggle no active" data-val="no">NO</button>
                    <button type="button" class="btn-toggle yes" data-val="yes">SÌ</button>
                </div>
            </div>

            <div class="q-card" id="card-anestesia-dentista">
                <div class="q-label">Ha <strong>mai fatto anestesia dal dentista</strong>? <span style="color:#d97706;">(scelga SÌ o NO)</span></div>
                <div class="q-toggle-wrap">
                    <button type="button" class="btn-toggle no" data-val="no">NO</button>
                    <button type="button" class="btn-toggle yes" data-val="yes">SÌ</button>
                </div>
            </div>
        </div>

        <!-- SEZIONE 2: CONDIZIONI GENERALI E PATOLOGIE -->
        ${catCondizioni.length ? `
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-hospital-user"></i> Condizioni Generali & Ricoveri</div>
            ${renderQuestionList(catCondizioni)}
        </div>` : ''}

        <!-- SEZIONE 3: FARMACI & TERAPIE -->
        ${catFarmaci.length ? `
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-pills"></i> Terapie Farmacologiche in Corso</div>
            ${renderQuestionList(catFarmaci)}
        </div>` : ''}

        <!-- SEZIONE 4: ALLERGIE & INTOLLERANZE -->
        ${catAllergie.length ? `
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-allergies"></i> Allergie & Intolleranze</div>
            ${renderQuestionList(catAllergie)}
        </div>` : ''}

        <!-- SEZIONE 5: ALTRE DOMANDE -->
        ${(catVaccini.length || catAbitudini.length || catAltro.length) ? `
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-notes-medical"></i> Stile di vita & Altre Informazioni</div>
            ${renderQuestionList([...catAbitudini, ...catVaccini, ...catAltro])}
        </div>` : ''}

        <!-- SEZIONE 6: FARMACI E NOTE LIBERE -->
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-file-pen"></i> Dettaglio Farmaci e Note Aggiuntive</div>
            <div class="form-group">
                <label for="farmaci-prescritti">Farmaci assunti regolarmente (nome commerciale, dosaggio):</label>
                <textarea id="farmaci-prescritti" class="form-control" placeholder="es. Cardioaspirina 100mg, Eutirox, Triatec... (lasciare vuoto se nessuno)"></textarea>
            </div>
            <div class="form-group">
                <label for="altre-malattie">Altre patologie, interventi recenti o note per il dentista:</label>
                <textarea id="altre-malattie" class="form-control" placeholder="Segnala qualsiasi altro dettaglio sanitario utile..."></textarea>
            </div>
        </div>

        <!-- SEZIONE 7: FIRMA GRAFOMETRICA TOUCH -->
        <div class="section-card">
            <div class="section-title"><i class="fa-solid fa-signature"></i> Firma del Paziente</div>
            <div class="section-desc">Apponga la sua firma nel riquadro sottostante usando il dito o il pennino (touchscreen) oppure il mouse.</div>
            
            <div class="signature-box" id="sig-box">
                <canvas id="signature-canvas"></canvas>
                <div class="sig-hint" id="sig-hint"><i class="fa-solid fa-pen"></i> Tracci qui la sua firma</div>
            </div>
            <div class="sig-actions">
                <button type="button" id="btn-clear-sig" class="btn-clear-sig">
                    <i class="fa-solid fa-rotate-left"></i> Cancella / Rifai firma
                </button>
            </div>

            <!-- Consenso Privacy -->
            <label class="consent-box">
                <input type="checkbox" id="privacy-consent" required>
                <span>Dichiaro che i dati sanitari indicati sono veritieri e completi, e rilascio il consenso al loro trattamento da parte del <strong>Centro Dentale Corbo</strong> ai sensi del Regolamento UE 2016/679 (GDPR) per fini diagnostici e terapeutici.</span>
            </label>
        </div>

        <!-- PULSANTE INVIO -->
        <div class="submit-btn-wrap">
            <button type="submit" id="btn-submit" class="btn-submit">
                <i class="fa-solid fa-paper-plane"></i> Conferma e Invia Anamnesi
            </button>
        </div>
    </form>
</div>

<script>
(function() {
    const token = ${JSON.stringify(session.token)};
    const form = document.getElementById('anamnesi-form');
    const btnSubmit = document.getElementById('btn-submit');
    const formError = document.getElementById('form-error');

    // Gestione pulsanti toggle SÌ / NO
    document.querySelectorAll('.q-card').forEach(card => {
        const btnNo = card.querySelector('.btn-toggle.no');
        const btnYes = card.querySelector('.btn-toggle.yes');
        if (!btnNo || !btnYes) return;

        btnNo.addEventListener('click', (e) => {
            e.preventDefault();
            btnNo.classList.add('active');
            btnYes.classList.remove('active');
            card.classList.remove('is-yes', 'mancante');
            if (card.id === 'card-crit-anestetico') {
                document.getElementById('group-anestetico-spec').style.display = 'none';
            }
        });

        btnYes.addEventListener('click', (e) => {
            e.preventDefault();
            btnYes.classList.add('active');
            btnNo.classList.remove('active');
            card.classList.add('is-yes');
            card.classList.remove('mancante');
            if (card.id === 'card-crit-anestetico') {
                document.getElementById('group-anestetico-spec').style.display = 'block';
                document.getElementById('anestetico-specifica').focus();
            }
        });
    });

    // Gestione Canvas Firma
    const canvas = document.getElementById('signature-canvas');
    const ctx = canvas.getContext('2d');
    const sigBox = document.getElementById('sig-box');
    const sigHint = document.getElementById('sig-hint');
    const btnClearSig = document.getElementById('btn-clear-sig');

    let isDrawing = false;
    let hasDrawn = false;
    let lastX = 0;
    let lastY = 0;

    function resizeCanvas() {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * ratio;
        canvas.height = rect.height * ratio;
        ctx.scale(ratio, ratio);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#0d47a1';
        ctx.lineWidth = 2.4;
    }

    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 50);

    function getCoords(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }

    function startDraw(e) {
        e.preventDefault();
        isDrawing = true;
        const { x, y } = getCoords(e);
        lastX = x;
        lastY = y;
        if (!hasDrawn) {
            hasDrawn = true;
            sigHint.style.display = 'none';
            sigBox.classList.add('has-signature');
        }
    }

    function draw(e) {
        if (!isDrawing) return;
        e.preventDefault();
        const { x, y } = getCoords(e);
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.stroke();
        lastX = x;
        lastY = y;
    }

    function endDraw(e) {
        if (!isDrawing) return;
        isDrawing = false;
    }

    // Touch events
    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', endDraw, { passive: false });
    canvas.addEventListener('touchcancel', endDraw, { passive: false });

    // Pointer / Mouse events
    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    window.addEventListener('mouseup', endDraw);

    btnClearSig.addEventListener('click', (e) => {
        e.preventDefault();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        hasDrawn = false;
        sigHint.style.display = 'flex';
        sigBox.classList.remove('has-signature');
    });

    // Invio Form
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        formError.style.display = 'none';
        formError.textContent = '';

        const cardAnestesia = document.getElementById('card-anestesia-dentista');
        const anestesiaSi = !!cardAnestesia.querySelector('.btn-toggle.yes.active');
        const anestesiaNo = !!cardAnestesia.querySelector('.btn-toggle.no.active');
        if (!anestesiaSi && !anestesiaNo) {
            cardAnestesia.classList.add('mancante');
            formError.textContent = 'Indichi se ha mai fatto anestesia dal dentista (SÌ o NO).';
            formError.style.display = 'block';
            cardAnestesia.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        if (!hasDrawn) {
            formError.textContent = 'Per favore, apponga la sua firma sul display prima di inviare.';
            formError.style.display = 'block';
            sigBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }

        const consent = document.getElementById('privacy-consent').checked;
        if (!consent) {
            formError.textContent = 'È necessario accettare il consenso al trattamento dei dati sanitari.';
            formError.style.display = 'block';
            return;
        }

        // Raccogli ID delle risposte SÌ
        const answers = [];
        document.querySelectorAll('.q-card[data-id]').forEach(card => {
            const id = parseInt(card.getAttribute('data-id'), 10);
            const isYes = card.querySelector('.btn-toggle.yes')?.classList.contains('active');
            if (isYes && id) answers.push(id);
        });

        // Avvisi critici
        const allergiaAnestetico = document.querySelector('#card-crit-anestetico .btn-toggle.yes')?.classList.contains('active') || false;
        const allergiaAnesteticoSpecifica = allergiaAnestetico ? document.getElementById('anestetico-specifica').value.trim() : '';
        const allergiaLattice = document.querySelector('#card-crit-lattice .btn-toggle.yes')?.classList.contains('active') || false;
        const portatorePacemaker = document.querySelector('#card-crit-pacemaker .btn-toggle.yes')?.classList.contains('active') || false;

        const textFields = {
            farmaciPrescritti: document.getElementById('farmaci-prescritti').value.trim(),
            altreMalattie: document.getElementById('altre-malattie').value.trim()
        };

        const signatureData = canvas.toDataURL('image/png');

        btnSubmit.disabled = true;
        btnSubmit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Invio in corso...';

        try {
            const res = await fetch('/anamnesi/' + token, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    answers,
                    critici: {
                        allergiaAnestetico,
                        allergiaAnesteticoSpecifica,
                        allergiaLattice,
                        portatorePacemaker,
                        anestesiaDentista: anestesiaSi
                    },
                    textFields,
                    firmaData: signatureData,
                    consensoPrivacy: true
                })
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Errore durante il salvataggio');

            // Ricarica la pagina: mostrerà la schermata di successo
            window.location.reload();
        } catch (err) {
            formError.textContent = 'Errore nell\'invio: ' + err.message;
            formError.style.display = 'block';
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Conferma e Invia Anamnesi';
        }
    });
})();
</script>

</body>
</html>`;
}

module.exports = {
    setupAnamnesiRoutes
};
