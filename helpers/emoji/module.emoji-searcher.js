class EmojiSearcher {
    constructor(db) {
        let smap = {};
        for (const r in db) {
            addSmapElement(smap, r);
        }
        this._smap = smap;
    }
    getEmojis(text) {
        text = text.replace(/\ufe0f\u200d/g, '\u200d');
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
