// Makes networking code written for Node run in Tabby's renderer, where the globals are the browser's:
// setTimeout & co. come from node:timers instead, since socks (proxies) and the OIDC token refresh
// call unref() and refresh() on the timers, which browser timer IDs don't have.
const TIMERS = 'setTimeout, clearTimeout, setInterval, clearInterval'

module.exports = function (source) {
    // Files that take their timers from node:timers already are fine as they are
    if (!/\b(setTimeout|setInterval)\(/.test(source) || /(['"])(node:)?timers\1/.test(source)) {
        return source
    }
    if (/^(import|export)\b/m.test(source)) {
        return `import { ${TIMERS} } from 'node:timers';\n${source}`
    }
    // After a 'use strict' directive, which has to stay first
    return source.replace(/^(\s*(['"])use strict\2;?)?/, directive => `${directive}\nconst { ${TIMERS} } = require('timers');\n`)
}
