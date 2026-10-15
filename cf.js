// Calcolo e validazione del Codice Fiscale: stessa logica del gestionale (server.js dello studio).
// Tenere allineato con quel file.

function pulisciPerCF(str) {
    return (str || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuove accenti (È->E, ecc.)
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
}
function codiceCognomeCF(cognome) {
    const s = pulisciPerCF(cognome);
    const consonanti = [...s].filter(c => !'AEIOU'.includes(c)).join('');
    const vocali = [...s].filter(c => 'AEIOU'.includes(c)).join('');
    return ((consonanti + vocali) + 'XXX').slice(0, 3);
}
function codiceNomeCF(nome) {
    const s = pulisciPerCF(nome);
    const consonanti = [...s].filter(c => !'AEIOU'.includes(c)).join('');
    const vocali = [...s].filter(c => 'AEIOU'.includes(c)).join('');
    if (consonanti.length >= 4) {
        return consonanti[0] + consonanti[2] + consonanti[3];
    }
    return ((consonanti + vocali) + 'XXX').slice(0, 3);
}
const MESI_CF = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'];

// Convenzione DB: 0 = Femmina, 1 = Maschio. dataNascita nel formato AAAA-MM-GG.
function codiceDataCF(dataNascita, sesso) {
    const d = new Date(dataNascita + 'T00:00:00Z');
    const anno = String(d.getUTCFullYear()).slice(-2);
    const mese = MESI_CF[d.getUTCMonth()];
    let giorno = d.getUTCDate();
    if (parseInt(sesso, 10) === 0) giorno += 40;
    return anno + mese + String(giorno).padStart(2, '0');
}

const CF_VALORI_DISPARI = {
    '0': 1, '1': 0, '2': 5, '3': 7, '4': 9, '5': 13, '6': 15, '7': 17, '8': 19, '9': 21,
    'A': 1, 'B': 0, 'C': 5, 'D': 7, 'E': 9, 'F': 13, 'G': 15, 'H': 17, 'I': 19, 'J': 21,
    'K': 2, 'L': 4, 'M': 18, 'N': 20, 'O': 11, 'P': 3, 'Q': 6, 'R': 8, 'S': 12, 'T': 14,
    'U': 16, 'V': 10, 'W': 22, 'X': 25, 'Y': 24, 'Z': 23
};
const CF_VALORI_PARI = {
    '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
    'A': 0, 'B': 1, 'C': 2, 'D': 3, 'E': 4, 'F': 5, 'G': 6, 'H': 7, 'I': 8, 'J': 9,
    'K': 10, 'L': 11, 'M': 12, 'N': 13, 'O': 14, 'P': 15, 'Q': 16, 'R': 17, 'S': 18, 'T': 19,
    'U': 20, 'V': 21, 'W': 22, 'X': 23, 'Y': 24, 'Z': 25
};

function calcolaCodiceFiscale({ cognome, nome, sesso, dataNascita, codiceBelfiore }) {
    if (!cognome || !nome || sesso === undefined || sesso === null || !dataNascita || !codiceBelfiore) {
        throw new Error('Dati insufficienti per calcolare il codice fiscale.');
    }
    const cf15 = codiceCognomeCF(cognome) + codiceNomeCF(nome) + codiceDataCF(dataNascita, sesso) + codiceBelfiore.toUpperCase();
    if (cf15.length !== 15) {
        throw new Error('Codice comune non valido.');
    }
    let somma = 0;
    for (let i = 0; i < 15; i++) {
        const ch = cf15[i];
        const tabella = ((i + 1) % 2 === 1) ? CF_VALORI_DISPARI : CF_VALORI_PARI;
        if (!(ch in tabella)) throw new Error(`Carattere non valido nel codice fiscale: ${ch}`);
        somma += tabella[ch];
    }
    const carattereControllo = String.fromCharCode(65 + (somma % 26));
    return cf15 + carattereControllo;
}

function carattereControlloCF(cf15) {
    let somma = 0;
    for (let i = 0; i < 15; i++) {
        const t = ((i + 1) % 2 === 1) ? CF_VALORI_DISPARI : CF_VALORI_PARI;
        if (!(cf15[i] in t)) return null;
        somma += t[cf15[i]];
    }
    return String.fromCharCode(65 + (somma % 26));
}

// Le lettere LMNPQRSTUV nelle posizioni numeriche sono omocodia: si riportano a cifre prima del confronto.
const CF_OMOCODIA = { L: '0', M: '1', N: '2', P: '3', Q: '4', R: '5', S: '6', T: '7', U: '8', V: '9' };
function normalizzaOmocodiaCF(cf15) {
    const pos = [6, 7, 9, 10, 12, 13, 14];
    return [...cf15].map((c, i) => (pos.includes(i) && CF_OMOCODIA[c]) ? CF_OMOCODIA[c] : c).join('');
}

// Ritorna un messaggio d'errore (stringa) oppure null se il CF e' coerente con i dati inseriti.
function validaCF({ cf, cognome, nome, sesso, dataNascita, codiceBelfiore }) {
    if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) {
        return 'Il codice fiscale non ha un formato valido.';
    }
    if (carattereControlloCF(cf.slice(0, 15)) !== cf[15]) {
        return 'Il codice fiscale non è valido (carattere di controllo errato).';
    }
    let atteso;
    try {
        atteso = calcolaCodiceFiscale({ cognome, nome, sesso, dataNascita, codiceBelfiore });
    } catch (e) {
        return 'Impossibile verificare il codice fiscale: ' + e.message;
    }
    if (normalizzaOmocodiaCF(cf.slice(0, 15)) !== atteso.slice(0, 15)) {
        return 'Il codice fiscale non corrisponde ai dati inseriti (cognome, nome, sesso, data e luogo di nascita).';
    }
    return null;
}

module.exports = { calcolaCodiceFiscale, validaCF };
