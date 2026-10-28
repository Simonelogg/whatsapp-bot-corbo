// Modulo Presenze: presenza giornaliera da QR in studio (con controllo della posizione GPS) e mini
// gestionale di ferie/permessi/malattie. Gira sul bot (Railway) per funzionare anche a PC dello studio spento.
// Si registra SOLO che il dipendente e' presente quel giorno: niente orario e niente coordinate, solo la
// distanza dallo studio come prova del controllo. Dati in <DATA_DIR>/presenze.json.
// La password del pannello viene SOLO da PRESENZE_PASSWORD.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function setupPresenzeRoutes(app, { DATA_DIR, POLL_SECRET }) {
    const FILE = path.join(DATA_DIR, 'presenze.json');
    const PASSWORD = process.env.PRESENZE_PASSWORD || null;
    if (!PASSWORD) console.warn('⚠️  PRESENZE_PASSWORD non impostata su Railway: il pannello presenze e\' disattivato.');

    const rnd = (n) => crypto.randomBytes(n).toString('hex');
    let db = { config: { studio: null, raggio: 150, qrToken: rnd(12) }, dipendenti: [], dispositivi: {}, presenze: [], assenze: [], nextId: 1 };
    try {
        if (fs.existsSync(FILE)) db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8')));
        console.log(`📦 Presenze: ${db.dipendenti.length} dipendenti, ${db.presenze.length} presenze.`);
    } catch (e) { console.error('⚠️  Errore caricamento presenze:', e.message); }

    function save() {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(FILE + '.tmp', JSON.stringify(db), 'utf8');
            fs.renameSync(FILE + '.tmp', FILE);
        } catch (e) { console.error('⚠️  Errore salvataggio presenze:', e.message); }
    }
    // Giorno di oggi in Italia (Railway lavora in UTC)
    const oggiRoma = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
    const RE_GIORNO = /^\d{4}-\d{2}-\d{2}$/;
    const PRECISIONE_MAX = 100; // metri
    function codiceNuovo() {
        let c;
        // 4 cifre, unico per dipendente. Indovinarlo non basta: servono anche il QR e il GPS in studio.
        do { c = String(crypto.randomInt(1000, 10000)); } while (db.dipendenti.some(d => d.codice === c));
        return c;
    }
    // Distanza in metri tra due coordinate (formula dell'emisenoverso)
    function distanza(a, b) {
        const R = 6371000, r = x => x * Math.PI / 180;
        const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
        return Math.round(2 * R * Math.asin(Math.sqrt(h)));
    }

    // ---- Limite ai tentativi sbagliati (password e codici personali): 5 errori = 10 minuti di blocco ----
    const errori = new Map();
    function bloccato(ip) { const e = errori.get(ip); return e && e.n >= 5 && Date.now() - e.t < 10 * 60 * 1000; }
    function sbagliato(ip) {
        const e = errori.get(ip);
        if (!e || Date.now() - e.t > 10 * 60 * 1000) errori.set(ip, { n: 1, t: Date.now() });
        else { e.n++; e.t = Date.now(); }
    }
    const ipDi = (req) => String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();

    // ---- Sessioni del pannello (in memoria: dopo un riavvio si rientra con la password) ----
    const sessioni = new Map();
    function admin(req, res, next) {
        const t = String(req.headers['x-presenze-token'] || '');
        const s = sessioni.get(t);
        if (!s || Date.now() - s > 12 * 3600 * 1000) { sessioni.delete(t); return res.status(401).json({ error: 'Sessione scaduta: rientra con la password.' }); }
        next();
    }

    app.get('/presenze', (req, res) => res.sendFile(path.join(__dirname, 'presenze.html')));
    app.get('/timbra', (req, res) => res.sendFile(path.join(__dirname, 'timbra.html')));

    app.post('/presenze/api/login', (req, res) => {
        const ip = ipDi(req);
        if (!PASSWORD) return res.status(503).json({ error: 'Pannello non configurato (manca PRESENZE_PASSWORD).' });
        if (bloccato(ip)) return res.status(429).json({ error: 'Troppi tentativi: riprova tra 10 minuti.' });
        const p = String((req.body && req.body.password) || '');
        const ok = p.length === PASSWORD.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(PASSWORD));
        if (!ok) { sbagliato(ip); return res.status(401).json({ error: 'Password errata.' }); }
        errori.delete(ip);
        const t = rnd(24);
        sessioni.set(t, Date.now());
        res.json({ token: t });
    });

    // ================= Pagina del dipendente (aperta dal QR) =================
    const qrValido = (k) => !!k && k === db.config.qrToken;
    function dipDaTelefono(device) {
        const disp = db.dispositivi[String(device || '')];
        return disp && db.dipendenti.find(x => x.id === disp.dip && x.attivo);
    }

    // Abbina il telefono al dipendente con il codice personale (una volta sola per telefono)
    app.post('/presenze/api/abbina', (req, res) => {
        const ip = ipDi(req);
        if (bloccato(ip)) return res.status(429).json({ error: 'Troppi tentativi: riprova tra 10 minuti.' });
        if (!qrValido(req.body.k)) return res.status(403).json({ error: 'QR non valido: inquadra il QR esposto in studio.' });
        const d = db.dipendenti.find(x => x.attivo && x.codice === String(req.body.codice || '').trim());
        if (!d) { sbagliato(ip); return res.status(401).json({ error: 'Codice personale errato.' }); }
        const dev = rnd(24);
        db.dispositivi[dev] = { dip: d.id, creato: new Date().toISOString() };
        save();
        res.json({ device: dev, nome: `${d.nome} ${d.cognome}` });
    });

    app.post('/presenze/api/stato', (req, res) => {
        const d = dipDaTelefono(req.body.device);
        if (!d) return res.status(401).json({ error: 'Telefono non abbinato.' });
        const ultime = db.presenze.filter(p => p.dip === d.id).map(p => p.giorno).sort().slice(-6).reverse();
        res.json({ nome: `${d.nome} ${d.cognome}`, oggi: oggiRoma(), ultime });
    });

    app.post('/presenze/api/timbra', (req, res) => {
        const { k, device, lat, lng, acc } = req.body || {};
        if (!qrValido(k)) return res.status(403).json({ error: 'QR non valido: inquadra il QR esposto in studio.' });
        const d = dipDaTelefono(device);
        if (!d) return res.status(401).json({ error: 'Telefono non abbinato.' });
        if (!db.config.studio) return res.status(503).json({ error: 'Posizione dello studio non ancora impostata nel pannello.' });
        if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'Posizione non disponibile: attiva il GPS.' });
        // Controllo severo: nessuna tolleranza oltre il raggio, e posizioni imprecise rifiutate
        // (una precisione oltre 100 m e' tipica di chi e' lontano o di una posizione approssimativa).
        const precisione = Number(acc);
        if (!(precisione > 0)) return res.status(400).json({ error: 'Posizione non disponibile: attiva il GPS e riprova.' });
        if (precisione > PRECISIONE_MAX) {
            return res.status(403).json({ error: `Posizione troppo imprecisa (± ${Math.round(precisione)} m): attiva la posizione precisa e riprova.` });
        }
        const dist = distanza(db.config.studio, { lat, lng });
        if (dist > db.config.raggio) {
            return res.status(403).json({ error: `Sei a ${dist} m dallo studio: la presenza si segna solo in studio.` });
        }
        const giorno = oggiRoma();
        const nome = `${d.nome} ${d.cognome}`;
        // Una sola presenza al giorno: riscansionare non crea doppioni
        if (db.presenze.some(p => p.dip === d.id && p.giorno === giorno)) return res.json({ ok: true, giorno, nome, gia: true });
        db.presenze.push({ id: db.nextId++, dip: d.id, giorno, dist, acc: Math.round(precisione) });
        save();
        res.json({ ok: true, giorno, nome });
    });

    // ================= Pannello (protetto da password) =================
    app.get('/presenze/api/dati', admin, (req, res) => {
        const nTel = {};
        Object.values(db.dispositivi).forEach(x => { nTel[x.dip] = (nTel[x.dip] || 0) + 1; });
        res.json({
            config: db.config,
            dipendenti: db.dipendenti.map(d => Object.assign({}, d, { telefoni: nTel[d.id] || 0 })),
            presenze: db.presenze,
            assenze: db.assenze
        });
    });

    app.post('/presenze/api/config', admin, (req, res) => {
        const { studio, raggio, nuovoQr } = req.body || {};
        if (studio && typeof studio.lat === 'number' && typeof studio.lng === 'number') db.config.studio = { lat: studio.lat, lng: studio.lng };
        if (raggio != null) db.config.raggio = Math.min(Math.max(parseInt(raggio, 10) || 150, 30), 1000);
        if (nuovoQr) db.config.qrToken = rnd(12);
        save();
        res.json(db.config);
    });

    function pulisciDip(b, d) {
        const s = (v) => String(v == null ? '' : v).trim();
        d.nome = s(b.nome); d.cognome = s(b.cognome); d.cf = s(b.cf).toUpperCase();
        d.attivo = b.attivo !== false;
        // orario: null = senza orario fisso, altrimenti ore per giorno 1=lun ... 6=sab
        d.orario = b.orario == null ? null : Object.fromEntries([1, 2, 3, 4, 5, 6].map(g => [g, Math.max(0, Number(b.orario[g]) || 0)]));
        const sl = b.saldi || {};
        d.saldi = { ferie: Number(sl.ferie) || 0, rol: Number(sl.rol) || 0, exfest: Number(sl.exfest) || 0, al: /^\d{4}-\d{2}-\d{2}$/.test(sl.al) ? sl.al : null };
        return d;
    }
    app.post('/presenze/api/dipendenti', admin, (req, res) => {
        const b = req.body || {};
        if (!String(b.nome || '').trim() || !String(b.cognome || '').trim()) return res.status(400).json({ error: 'Nome e cognome obbligatori.' });
        let d = b.id && db.dipendenti.find(x => x.id === b.id);
        if (!d) { d = { id: db.nextId++, codice: codiceNuovo() }; db.dipendenti.push(d); }
        pulisciDip(b, d);
        if (b.nuovoCodice) d.codice = codiceNuovo();
        if (b.scollegaTelefoni) for (const k of Object.keys(db.dispositivi)) if (db.dispositivi[k].dip === d.id) delete db.dispositivi[k];
        save();
        res.json(d);
    });

    // Caricamento iniziale delle anagrafiche: aggiunge solo chi non c'e' gia' (stesso cognome + nome)
    app.post('/presenze/api/importa', admin, (req, res) => {
        const lista = Array.isArray(req.body && req.body.dipendenti) ? req.body.dipendenti : [];
        const chiave = (c, n) => `${String(c).trim().toLowerCase()}|${String(n).trim().toLowerCase()}`;
        let aggiunti = 0;
        for (const b of lista) {
            if (!b.nome || !b.cognome) continue;
            if (db.dipendenti.some(x => chiave(x.cognome, x.nome) === chiave(b.cognome, b.nome))) continue;
            db.dipendenti.push(pulisciDip(b, { id: db.nextId++, codice: codiceNuovo() }));
            aggiunti++;
        }
        save();
        res.json({ aggiunti, totale: db.dipendenti.length });
    });

    // Presenza segnata a mano dal pannello (resta segnata come manuale)
    app.post('/presenze/api/presenze', admin, (req, res) => {
        const { dip, giorno, nota } = req.body || {};
        if (!db.dipendenti.some(d => d.id === dip) || !RE_GIORNO.test(giorno)) return res.status(400).json({ error: 'Dati non validi.' });
        if (db.presenze.some(p => p.dip === dip && p.giorno === giorno)) return res.status(409).json({ error: 'Presenza gia\' registrata quel giorno.' });
        const p = { id: db.nextId++, dip, giorno, manuale: true, nota: String(nota || '').slice(0, 200) };
        db.presenze.push(p);
        save();
        res.json(p);
    });
    app.delete('/presenze/api/presenze/:id', admin, (req, res) => {
        db.presenze = db.presenze.filter(p => p.id !== parseInt(req.params.id, 10));
        save();
        res.json({ ok: true });
    });

    const TIPI_ASSENZA = ['ferie', 'rol', 'exfest', 'malattia', 'altro'];
    app.post('/presenze/api/assenze', admin, (req, res) => {
        const { dip, tipo, dal, quantita, nota } = req.body || {};
        const al = req.body.al || dal;
        if (!db.dipendenti.some(d => d.id === dip) || !TIPI_ASSENZA.includes(tipo) || !RE_GIORNO.test(dal) || !RE_GIORNO.test(al) || al < dal) {
            return res.status(400).json({ error: 'Dati non validi.' });
        }
        const a = { id: db.nextId++, dip, tipo, dal, al, quantita: Number(quantita) || 0, nota: String(nota || '').slice(0, 200), creato: new Date().toISOString() };
        db.assenze.push(a);
        save();
        res.json(a);
    });
    app.delete('/presenze/api/assenze/:id', admin, (req, res) => {
        db.assenze = db.assenze.filter(a => a.id !== parseInt(req.params.id, 10));
        save();
        res.json({ ok: true });
    });

    // Ponte futuro con DentalSoft: lettura completa con la stessa chiave del prelievo messaggi
    app.get('/presenze/api/export', (req, res) => {
        if (!POLL_SECRET || req.query.key !== POLL_SECRET) return res.sendStatus(403);
        res.json({ dipendenti: db.dipendenti.map(({ codice, ...d }) => d), presenze: db.presenze, assenze: db.assenze });
    });

    return { savePresenze: save };
}

module.exports = { setupPresenzeRoutes };
