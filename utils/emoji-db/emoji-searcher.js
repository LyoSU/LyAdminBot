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
        let lastStart = -1;
        let index = 0;
        for (const rune of text) {
            const cp = rune.codePointAt(0).toString(16).padStart(4, '0');
            if (cp in sp) {
                if (lastStart < 0) {
                    lastStart = index;
                }
                if ('code' in sp[cp]) {
                    lastCode = sp[cp].code;
                }
                if ('child' in sp[cp]) {
                    sp = sp[cp].child;
                    root = false;
                }
                else {
                    if (lastCode != '') {
                        emojis.push({found: lastCode, offset: lastStart, length: index-lastStart+rune.length});
                        lastCode = '';
                    }
                    lastStart = -1;
                    sp = this._smap;
                    root = true;
                }
            }
            else {
                if (lastCode != '') {
                    emojis.push({found: lastCode, offset: lastStart, length: index-lastStart});
                    lastCode = '';
                }
                lastStart = -1;
                sp = this._smap;
                if (!root) {
                    root = true;
                    // retry search in root
                    if (cp in sp) {
                        if (lastStart < 0) {
                            lastStart = index;
                        }
                        if ('code' in sp[cp]) {
                            lastCode = sp[cp].code;
                        }
                        if ('child' in sp[cp]) {
                            sp = sp[cp].child;
                            root = false;
                        } else {
                            if (lastCode != '') {
                                emojis.push({found: lastCode, offset: lastStart, length: index-lastStart+rune.length});
                                lastCode = '';
                            }
                            lastStart = -1;
                            sp = this._smap;
                            root = true;
                        }
                    }
                }
            }
            index += rune.length;
        }
        if (lastCode != '') {
            emojis.push({found: lastCode, offset: lastStart, length: index-lastStart});
        }
        emojis.forEach(e => e.emoji = text.substr(e.offset, e.length));
        return emojis;
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

module.exports = EmojiSearcher;
