import { PassThrough, Writable } from 'stream'
import { Observable, Subject } from 'rxjs'
import { Exec, KubeConfig, V1Status } from '@kubernetes/client-node'
import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { KubeObject, KubeTerminalProfileOptions } from './api'
import { kubeJson, kubeRequest } from './kube/http'

/** Runs bash where the image has it, sh otherwise; many images leave TERM unset, which breaks line editing */
const DEFAULT_SHELL = ['/bin/sh', '-c', '[ -z "$TERM" ] && export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash || exec sh']

export interface KubeSessionStartOptions {
    columns: number
    rows: number
}

function podPath (options: KubeTerminalProfileOptions): string {
    return `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}`
}

/** The part of the exec WebSocket the session uses */
interface ExecSocket {
    on: (event: 'close', listener: () => void) => void
    close: () => void
}

abstract class KubeSession extends BaseSession {
    protected message = new Subject<string>()

    /** Notices for the user, outside of the container's own output */
    get message$ (): Observable<string> { return this.message }

    constructor (logger: Logger, protected kc: KubeConfig, protected options: KubeTerminalProfileOptions) {
        super(logger)
    }

    supportsWorkingDirectory (): boolean {
        return false
    }

    async getWorkingDirectory (): Promise<string|null> {
        return null
    }

    async gracefullyKillProcess (): Promise<void> {
        this.kill()
    }

    async destroy (): Promise<void> {
        await super.destroy()
        this.message.complete()
    }
}

/** An interactive shell in a container, as `kubectl exec -it` */
export class KubeShellSession extends KubeSession {
    private stdin = new PassThrough()
    /** Exec sends the terminal size from these, and again on 'resize' */
    private stdout: (Writable & { columns: number, rows: number })|null = null
    private socket: ExecSocket|null = null

    async start (size: KubeSessionStartOptions): Promise<void> {
        await this.checkContainerRunning()

        const stdout = Object.assign(new Writable({
            write: (chunk: Buffer, _encoding, callback) => {
                this.emitOutput(chunk)
                callback()
            },
        }), size)
        this.stdout = stdout

        const command = this.options.command.trim() ? this.options.command.trim().split(/\s+/) : DEFAULT_SHELL
        let status: V1Status|null = null
        const socket = await new Exec(this.kc).exec(
            this.options.namespace,
            this.options.pod,
            this.options.container,
            command,
            stdout,
            null,
            this.stdin,
            true,
            s => { status = s },
        )
        this.socket = socket
        this.open = true

        socket.on('close', () => {
            const failure = status as V1Status|null
            if (failure?.status === 'Failure' && failure.reason !== 'NonZeroExitCode') {
                this.message.next(failure.message ?? 'The command failed')
            }
            this.destroy()
        })
    }

    /** Exec into a container that isn't running fails with a bare "400"; say why instead */
    private async checkContainerRunning (): Promise<void> {
        const pod = await kubeJson<KubeObject>(this.kc, 'GET', podPath(this.options))
        const statuses: any[] = [...pod.status?.containerStatuses ?? [], ...pod.status?.initContainerStatuses ?? []]
        const status = statuses.find(x => x.name === this.options.container)
        if (!status) {
            throw new Error(`The pod ${this.options.pod} has no container "${this.options.container}" (it is ${pod.status?.phase ?? 'Unknown'})`)
        }
        if (!status.state?.running) {
            const state = status.state?.waiting ?? status.state?.terminated
            const reason = state?.reason ? `${state.reason}${state.message ? ': ' + state.message : ''}` : 'it is not running'
            throw new Error(`Container ${this.options.container} is not running: ${reason}`)
        }
    }

    resize (columns: number, rows: number): void {
        if (!this.stdout) {
            return
        }
        this.stdout.columns = columns
        this.stdout.rows = rows
        this.stdout.emit('resize')
    }

    write (data: Buffer): void {
        this.stdin.write(data)
    }

    kill (): void {
        this.socket?.close()
        this.stdin.end()
    }
}

/** A container's logs, followed, as `kubectl logs -f` */
export class KubeLogsSession extends KubeSession {
    private abort = new AbortController()

    async start (_size?: KubeSessionStartOptions): Promise<void> {
        const body = await kubeRequest(this.kc, 'GET', `${podPath(this.options)}/log`, {
            query: {
                container: this.options.container,
                follow: true,
                tailLines: this.options.tailLines > 0 ? this.options.tailLines : undefined,
                previous: this.options.previous || undefined,
            },
            signal: this.abort.signal,
        })
        this.open = true

        // Decodes characters split between chunks
        body.setEncoding('utf-8')
        body.on('data', (chunk: string) => {
            // Log lines end with a bare newline, which the terminal would only move down from
            this.emitOutput(Buffer.from(chunk.replace(/\r?\n/g, '\r\n')))
        })
        body.on('error', e => {
            if (!this.abort.signal.aborted) {
                this.message.next(e.message)
            }
        })
        body.on('close', () => {
            if (!this.abort.signal.aborted) {
                this.message.next('The log stream has ended')
            }
            this.destroy()
        })
    }

    resize (): void {
        // Logs don't depend on the terminal size
    }

    /** Logs take no input; Enter adds an empty line, to mark a point in the stream */
    write (data: Buffer): void {
        if (data.includes(13)) {
            this.emitOutput(Buffer.from('\r\n'))
        }
    }

    kill (): void {
        this.abort.abort()
    }
}
