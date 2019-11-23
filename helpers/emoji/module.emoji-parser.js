module.exports = {
  emjSep: '-',
  toCodePoint: function (emj, sep) {
    let r = []
    for (const c of emj) {
      r.push(c.codePointAt(0).toString(16).padStart(4, '0'))
    }
    return r.join(sep || this.emjSep)
  },
  fromCodePoint: function (codepoint) {
    let code = typeof codepoint === 'string' ? parseInt(codepoint, 16) : codepoint
    return String.fromCodePoint(code)
  },
  toCodePointArrTxt: function (arr, sep) {
    let cpArr = []; sep = sep || this.emjSep
    for (let ix = 0; ix < arr.length; ix++) {
      cpArr.push(this.toCodePoint(arr[ix], sep))
    }
    return cpArr
  }
}
