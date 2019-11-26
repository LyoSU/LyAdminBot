class EmojiSearcher {
    constructor(db) {
        let smap = {};
        for (const r in db) {
            addSmapElement(smap, r);
        }
        this._smap = smap;
    }
    getEmojis(text) {
        let sp = this._smap;
        let lastCode = '';
        let emojis = [];
        let root = true;
        for (const rune of text) {
            const cp = rune.codePointAt(0).toString(16).padStart(4, '0');
            if (cp in sp) {
                if ('code' in sp[cp]) {
                    lastCode = sp[cp].code;
                }
                if ('child' in sp[cp]) {
                    sp = sp[cp].child;
                    root = false;
                }
                else {
                    if (lastCode != '') {
                        emojis.push(lastCode);
                        lastCode = '';
                    }
                    sp = this._smap;
                    root = true;
                }
            }
            else {
                if (lastCode != '') {
                    emojis.push(lastCode);
                    lastCode = '';
                }
                sp = this._smap;
                if (!root) {
                    root = true;
                    // retry search in root
                    if (cp in sp) {
                        if ('code' in sp[cp]) {
                            lastCode = sp[cp].code;
                        }
                        if ('child' in sp[cp]) {
                            sp = sp[cp].child;
                            root = false;
                        } else {
                            if (lastCode != '') {
                                emojis.push(lastCode);
                                lastCode = '';
                            }
                            sp = this._smap;
                            root = true;
                        }
                    }
                }
            }
        }
        if (lastCode != '') {
            emojis.push(lastCode);
        }
        return emojis;
    }
}

class EmojiDb {
    constructor({ useDefaultDb, dbDir }) {
        // set separator
        this.codePointSeparator = '-';
        // default db filenames
        const filePrefx = 'emojilist_';
        const fileSuffx = '.json';
        // load default db
        if(useDefaultDb){
            dbDir = __dirname + '/database/';
        }
        // empty db
        if(!dbDir && !useDefaultDb){
            this.dbData = {};
        }
        // load list
        else{
            const fs = require('fs');
            let dbFiles = fs.readdirSync(dbDir);
            // remove non db files
            dbFiles = dbFiles.filter((dbFile) => {
                if (!dbFile.endsWith('.json') || !dbFile.startsWith(filePrefx)) {
                    return false;
                }
                return true;
            });
            // make emoji db nums
            dbFiles = dbFiles.map((dbFile) => {
                return dbFile
                    .replace(new RegExp('^'+filePrefx),'')
                    .replace(new RegExp(fileSuffx+'$'),'');
            });
            // sort dbs
            dbFiles.sort((a, b) => {
                a = !a.match(/unqualified/) ? parseFloat(a) : Infinity;
                b = !b.match(/unqualified/) ? parseFloat(b) : Infinity;
                return a - b;
            });
            // load dbs
            let emojiDbData = {};
            for (const dbFile of dbFiles) {
                let loadEmojiDbData = require(dbDir + filePrefx + dbFile + fileSuffx);
                emojiDbData = Object.assign({}, emojiDbData, loadEmojiDbData);
            }
            // return db
            this.dbData = emojiDbData;
        }
    }
    searchFromText({ input, fixCodePoints, showData }){
        let foundEmojis = new EmojiSearcher(this.dbData).getEmojis(input);
        if(showData){
            const emojisData = [];
            for(let e of foundEmojis){
                e = fixEmojiCodePoint(e, this.dbData);
                emojisData.push(this.dbData[e]);
            }
            return emojisData;
        }
        else{
            if(fixCodePoints){
                let fixedFoundEmojis = [];
                for(let e of foundEmojis){
                    e = fixEmojiCodePoint(e, this.dbData);
                    fixedFoundEmojis.push(e);
                }
                foundEmojis = fixedFoundEmojis;
            }
            return foundEmojis;
        }
    }
    toCodePoint(emoji, separator){
        let codePointArray = [];
        for (const textContent of emoji) {
            codePointArray.push(textContent.codePointAt(0).toString(16).padStart(4, '0'));
        }
        return codePointArray.join(separator || this.codePointSeparator);
    }
    fromCodePoint(codePoint){
        codePoint = typeof codePoint === 'string' ? parseInt(codePoint, 16) : codePoint;
        return String.fromCodePoint(codePoint);
    }
    toCodePointArray(emojiArray, separator){
        let codePointArray = [];
        separator = separator || this.codePointSeparator;
        for (let ix = 0; ix < emojiArray.length; ix++) {
            codePointArray.push(this.toCodePoint(emojiArray[ix], separator));
        }
        return codePointArray;
    }
}

function addSmapElement(smap, code) {
    let c = code.split('-');
    let m = smap;
    for (let i = 0; i < c.length - 1; i++) {
        const p = c[i];
        if (!(p in m)) {
            m[p] = {};
        }
        if (!('child' in m[p])) {
            m[p].child = {};
        }
        m = m[p].child;
    }
    let p = c[c.length - 1];
    if (!(p in m)) {
        m[p] = {};
    }
    m[p].code = code;
}

function fixEmojiCodePoint(codePoint, dbData){
    if(dbData[codePoint] && dbData[codePoint].qualified && dbData[dbData[codePoint].qualified]){
        return dbData[codePoint].qualified;
    }
    return codePoint;
}

module.exports = EmojiDb;
