/* eslint-disable @typescript-eslint/no-require-imports */
// The sessions extend tabby-terminal's BaseSession, which can't load outside of Tabby (it brings Angular and
// the DOM along). Stand in for it with the part the sessions use, collecting what they would print.
import Module from 'module'
import { Subject } from 'rxjs'

export class FakeBaseSession {
    open = false
    printed = ''
    protected destroyed = new Subject<void>()
    readonly ended: Promise<void>
    private resolveEnded: () => void

    constructor (protected logger: unknown) {
        this.ended = new Promise(resolve => { this.resolveEnded = resolve })
    }

    protected emitOutput (data: Buffer): void {
        this.printed += data.toString()
    }

    async destroy (): Promise<void> {
        if (this.open) {
            this.open = false
            this.destroyed.next()
        }
        this.resolveEnded()
    }
}

const load = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
    if (request === 'tabby-terminal') {
        return { BaseSession: FakeBaseSession }
    }
    return load.call(this, request, ...rest)
}
