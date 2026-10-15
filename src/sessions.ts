import * as http from 'http'
import { PassThrough, Writable } from 'stream'
import { Observable, Subject } from 'rxjs'
import { Exec, KubeConfig, V1Status } from '@kubernetes/client-node'
import { Logger } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { KubeObject, KubeTerminalProfileOptions } from './api'
import { kubeJson } from './kube/http'
import { colorPrefix, LineSplitter, openLogStream, shortPodName } from './kube/logs'
import { createNodeShellPod, deletePod, NODE_SHELL_COMMAND, NODE_SHELL_CONTAINER, waitForPod } from './kube/nodeShell'
import { relatedPodsQuery } from './kube/related'
import { findKind, resourcePath } from './kube/resources'
import { ResourceWatcher } from './kube/watcher'

/** Runs bash where the image has it, sh otherwise; many images leave TERM unset, which breaks line editing */
const DEFAULT_SHELL = ['/bin/sh', '-c', '[ -z "$TERM" ] && export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash || exec sh']
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export interface KubeSessionStartOptions {
    columns: number
    rows: number
}

function podPath (options: KubeTerminalProfileOptions): string {
    return `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}`
}

/** Log lines end with a bare newline, which the terminal would only move down from */
function toTerminal (text: string): Buffer {
    return Buffer.from(text.replace(/\r?\n/g, '\r\n'))
}

function streamEnded (stream: http.IncomingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
        stream.on('error', reject)
        stream.on('close', () => resolve())
    })
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

        let status: V1Status|null = null
        const socket = await new Exec(this.kc).exec(
            this.options.namespace,
            this.options.pod,
            this.options.container,
            this.command(),
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

    protected command (): string[] {
        return this.options.command.trim() ? this.options.command.trim().split(/\s+/) : DEFAULT_SHELL
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

/**
 * A shell on a node: starts a privileged pod there, enters the node's namespaces from it,
 * and deletes the pod when the shell ends
 */
export class KubeNodeShellSession extends KubeShellSession {
    private podName: string|null = null
    private starting = new AbortController()

    async start (size: KubeSessionStartOptions): Promise<void> {
        this.message.next(`Starting a pod on node ${this.options.node} (${this.options.image})`)
        const pod = await createNodeShellPod(this.kc, this.options.namespace, this.options.node, this.options.image)
        this.podName = pod.metadata.name
        try {
            await waitForPod(this.kc, this.options.namespace, this.podName, progress => {
                this.message.next(`${this.podName}: ${progress}`)
            }, this.starting.signal)
            this.options = { ...this.options, pod: this.podName, container: NODE_SHELL_CONTAINER }
            await super.start(size)
        } catch (e) {
            await this.removePod()
            throw e
        }
    }

    protected command (): string[] {
        return NODE_SHELL_COMMAND
    }

    kill (): void {
        this.starting.abort()
        super.kill()
    }

    async destroy (): Promise<void> {
        await super.destroy()
        await this.removePod()
    }

    private async removePod (): Promise<void> {
        const name = this.podName
        this.podName = null
        if (name) {
            await deletePod(this.kc, this.options.namespace, name).catch(e => {
                this.logger.error(`Could not delete the node shell pod ${name}`, e)
            })
        }
    }
}

/** A container's logs, followed, as `kubectl logs -f` */
export class KubeLogsSession extends KubeSession {
    private abort = new AbortController()

    async start (_size?: KubeSessionStartOptions): Promise<void> {
        const body = await openLogStream(this.kc, this.options.namespace, this.options.pod, {
            container: this.options.container,
            follow: true,
            tailLines: this.options.tailLines,
            previous: this.options.previous,
        }, this.abort.signal)
        this.open = true

        // Decodes characters split between chunks
        body.setEncoding('utf-8')
        body.on('data', (chunk: string) => this.emitOutput(toTerminal(chunk)))
        streamEnded(body).catch(e => {
            if (!this.abort.signal.aborted) {
                this.message.next(e.message)
            }
        }).then(() => {
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

/** A pod's container that has a log to read now: running, or finished but not read yet */
function readableContainer (pod: KubeObject, container: string, seenRestarts: number|undefined): boolean {
    if (pod.metadata.deletionTimestamp) {
        return false
    }
    const status = (pod.status?.containerStatuses ?? []).find((x: any) => x.name === container)
    if (status?.state?.running) {
        // Again after each restart, as a new instance with a log of its own
        return seenRestarts === undefined || (status.restartCount ?? 0) > seenRestarts
    }
    // Once, as a completed job's
    return !!status?.state?.terminated && seenRestarts === undefined
}

/**
 * The logs of every container of the pods a workload or service selects, each line prefixed
 * with its pod, as stern and `kubectl logs -l` do. Pods that come later, as in a rollout, join in,
 * and a restarted container is followed again.
 */
export class KubeWorkloadLogsSession extends KubeLogsSession {
    private watcher: ResourceWatcher|null = null
    private streams = new Map<string, AbortController>()
    /** The restart count of each container when its stream started, by "pod uid/container" */
    private seenRestarts = new Map<string, number>()
    private colors = new Map<string, number>()
    private recheckTimer: ReturnType<typeof setTimeout>|null = null
    private stopped = false

    async start (): Promise<void> {
        const kind = findKind(this.options.workloadKind)
        if (!kind) {
            throw new Error(`Logs of ${this.options.workloadKind} aren't supported`)
        }
        const obj = await kubeJson<KubeObject>(this.kc, 'GET', resourcePath(kind, this.options.namespace, this.options.workloadName))
        const query = relatedPodsQuery(kind, obj)
        if (!query) {
            throw new Error(`${kind.kind} ${this.options.workloadName} selects no pods`)
        }
        this.watcher = new ResourceWatcher(this.kc, findKind('pods')!, query)
        this.watcher.changed$.subscribe(() => this.followNewContainers())
        this.watcher.start()
        this.open = true
    }

    private followNewContainers (): void {
        if (this.stopped || !this.watcher) {
            return
        }
        for (const pod of this.watcher.items) {
            const containers: string[] = (pod.spec?.containers ?? []).map((c: any) => c.name)
            for (const container of containers) {
                const key = `${pod.metadata.uid}/${container}`
                if (!this.streams.has(key) && readableContainer(pod, container, this.seenRestarts.get(key))) {
                    this.follow(pod, container, containers.length > 1, key)
                }
            }
        }
    }

    private async follow (pod: KubeObject, container: string, labelContainer: boolean, key: string): Promise<void> {
        const controller = new AbortController()
        this.streams.set(key, controller)
        const restarted = this.seenRestarts.has(key)
        const status = (pod.status?.containerStatuses ?? []).find((x: any) => x.name === container)
        this.seenRestarts.set(key, status?.restartCount ?? 0)
        if (!this.colors.has(pod.metadata.uid)) {
            this.colors.set(pod.metadata.uid, this.colors.size)
        }
        const label = shortPodName(pod.metadata.name, this.options.workloadName) + (labelContainer ? ` ${container}` : '')
        const prefix = colorPrefix(label, this.colors.get(pod.metadata.uid)!)
        this.notice(restarted ? `+ ${label} (restarted)` : `+ ${label}`)

        const lines = new LineSplitter()
        const print = (text: string[]) => {
            if (text.length) {
                this.emitOutput(Buffer.from(text.map(x => prefix + x + '\r\n').join('')))
            }
        }
        try {
            const body = await openLogStream(this.kc, pod.metadata.namespace!, pod.metadata.name, {
                container,
                follow: true,
                // A restarted container's new instance is read from its start
                tailLines: restarted ? undefined : this.options.tailLines,
            }, controller.signal)
            body.setEncoding('utf-8')
            body.on('data', (chunk: string) => print(lines.push(chunk)))
            await streamEnded(body)
        } catch (e) {
            if (!controller.signal.aborted) {
                this.notice(`${label}: ${e.message}`)
            }
        }
        const rest = lines.flush()
        if (rest !== null) {
            print([rest])
        }
        this.streams.delete(key)
        if (!this.stopped) {
            this.notice(`- ${label}`)
            // A restart reported before the stream ended brings no further pod change to react to
            this.recheckTimer ??= setTimeout(() => {
                this.recheckTimer = null
                this.followNewContainers()
            }, 3000)
        }
    }

    private notice (text: string): void {
        this.emitOutput(Buffer.from(`${DIM}${text}${RESET}\r\n`))
    }

    kill (): void {
        this.stopped = true
        this.watcher?.stop()
        if (this.recheckTimer) {
            clearTimeout(this.recheckTimer)
        }
        for (const controller of this.streams.values()) {
            controller.abort()
        }
    }
}
