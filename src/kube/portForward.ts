import * as net from 'net'
import { Observable, Subject } from 'rxjs'
import WebSocket from 'ws'
import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { KubeApiError, kubeJson } from './http'
import { relatedPodsQuery } from './related'
import { findKind, KubeResourceKind, podReady, resourcePath } from './resources'

/** Kinds whose objects lead to pods to forward to */
const FORWARDABLE_KINDS = ['pods', 'services', 'deployments', 'statefulsets', 'daemonsets']
/** Pauses reading from a local connection while this much is waiting to go to the cluster */
const MAX_BUFFERED = 4 * 1024 * 1024

export interface ForwardablePort {
    port: number
    name?: string
}

export function canForward (kind: KubeResourceKind): boolean {
    return FORWARDABLE_KINDS.includes(kind.id)
}

function containerPorts (podSpec: any): ForwardablePort[] {
    return (podSpec?.containers ?? []).flatMap((c: any) => c.ports ?? [])
        .filter((p: any) => (p.protocol ?? 'TCP') === 'TCP')
        .map((p: any) => ({ port: p.containerPort, name: p.name }))
}

/** The ports an object declares: its containers' ports, or a service's ports */
export function forwardablePorts (kind: KubeResourceKind, obj: KubeObject): ForwardablePort[] {
    switch (kind.id) {
        case 'pods':
            return containerPorts(obj.spec)
        case 'services':
            return (obj.spec?.ports ?? [])
                .filter((p: any) => (p.protocol ?? 'TCP') === 'TCP')
                .map((p: any) => ({ port: p.port, name: p.name }))
        default:
            return containerPorts(obj.spec?.template?.spec)
    }
}

/** The pod to forward to among those of a service or workload: a ready one, as kubectl picks */
export function pickPod (pods: KubeObject[]): KubeObject|null {
    const running = pods.filter(x => x.status?.phase === 'Running' && !x.metadata.deletionTimestamp)
    return running.find(x => {
        const [ready, total] = podReady(x)
        return ready === total
    }) ?? (running.length ? running[0] : null)
}

/** The container port a service port leads to in a pod: targetPort, by number or by name */
export function servicePortInPod (service: KubeObject, port: number, pod: KubeObject): number {
    const servicePort = (service.spec?.ports ?? []).find((p: any) => p.port === port)
    const target = servicePort?.targetPort ?? port
    if (typeof target === 'number') {
        return target
    }
    if (/^\d+$/.test(target)) {
        return Number(target)
    }
    const named = containerPorts(pod.spec).find(p => p.name === target)
    if (!named) {
        throw new Error(`The pod ${pod.metadata.name} has no port named "${target}"`)
    }
    return named.port
}

export interface PortForwardTarget {
    kind: KubeResourceKind
    namespace: string
    name: string
    /** The port of the object: a container port, or a service's port */
    port: number
}

/** Finds the pod and its port a forward leads to now */
export async function resolveTarget (kc: KubeConfig, target: PortForwardTarget): Promise<{ pod: string, port: number }> {
    if (target.kind.id === 'pods') {
        return { pod: target.name, port: target.port }
    }
    const obj = await kubeJson<KubeObject>(kc, 'GET', resourcePath(target.kind, target.namespace, target.name))
    const query = relatedPodsQuery(target.kind, obj)
    if (!query) {
        throw new Error(`${target.kind.kind} ${target.name} selects no pods`)
    }
    const pods = await kubeJson<{ items: KubeObject[] }>(kc, 'GET', resourcePath(findKind('pods')!, target.namespace), {
        query: { labelSelector: query.labelSelector },
    })
    const pod = pickPod(pods.items)
    if (!pod) {
        throw new Error(`${target.kind.kind} ${target.name} has no running pods`)
    }
    const port = target.kind.id === 'services' ? servicePortInPod(obj, target.port, pod) : target.port
    return { pod: pod.metadata.name, port }
}

interface ForwardSocket {
    ws: WebSocket
    /**
     * Messages that came before anyone listened: the server sends the port headers right as the
     * stream opens, often in the same read as the handshake, before the opener's continuation runs
     */
    early: Buffer[]
    stopCollecting: () => void
}

/** Opens a port-forward stream to one port of a pod */
async function openForwardSocket (kc: KubeConfig, namespace: string, pod: string, port: number): Promise<ForwardSocket> {
    const cluster = kc.getCurrentCluster()
    if (!cluster) {
        throw new Error('No cluster in the current context')
    }
    const url = `${cluster.server.replace(/\/+$/, '').replace(/^http/, 'ws')}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/portforward?ports=${port}`
    const options: any = {}
    // The TLS agent and the Authorization header, as for API requests
    await kc.applyToHTTPSOptions(options)
    const ws = new WebSocket(url, ['v4.channel.k8s.io'], options)
    const early: Buffer[] = []
    const collect = (data: Buffer) => early.push(data)
    ws.on('message', collect)
    await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', reject)
        // Without this, a refusal is a bare "Unexpected server response: 400"
        ws.once('unexpected-response', (_request, response) => {
            let text = ''
            response.on('data', chunk => { text += chunk })
            response.on('end', () => {
                let message = `${response.statusCode} ${response.statusMessage}`
                try {
                    message = JSON.parse(text).message ?? message
                } catch { }
                reject(new KubeApiError(message, response.statusCode ?? 0))
            })
        })
    })
    return { ws, early, stopCollecting: () => ws.off('message', collect) }
}

/**
 * Forwards a local port to a port of a pod, or of a service or workload through one of its pods.
 * Every local connection gets a stream of its own, as with kubectl. The pod is looked up again
 * after a connection to it fails, so the forward survives the pod being replaced.
 */
export class PortForwarder {
    localPort = 0
    connections = 0
    /** The last failure of a connection; later connections are still tried */
    error: string|null = null
    private server = net.createServer(socket => this.handle(socket))
    private sockets = new Set<net.Socket>()
    private resolved: { pod: string, port: number }|null = null
    private changed = new Subject<void>()

    /** Fires when connections come and go or fail */
    get changed$ (): Observable<void> { return this.changed }

    constructor (
        private kc: KubeConfig,
        public readonly contextName: string,
        public readonly target: PortForwardTarget,
    ) { }

    /** Listens on localhost; port 0 picks a free one */
    async start (localPort: number): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject)
            this.server.listen(localPort, '127.0.0.1', () => {
                this.server.off('error', reject)
                resolve()
            })
        })
        this.localPort = (this.server.address() as net.AddressInfo).port
    }

    stop (): void {
        this.server.close()
        for (const socket of this.sockets) {
            socket.destroy()
        }
        this.changed.complete()
    }

    private async handle (socket: net.Socket): Promise<void> {
        socket.pause()
        this.sockets.add(socket)
        this.connections++
        this.changed.next()
        socket.on('error', () => null)
        socket.on('close', () => {
            this.sockets.delete(socket)
            this.connections--
            this.changed.next()
        })

        try {
            this.resolved ??= await resolveTarget(this.kc, this.target)
            this.pipe(socket, await openForwardSocket(this.kc, this.target.namespace, this.resolved.pod, this.resolved.port))
        } catch (e) {
            this.resolved = null
            this.fail(e.message)
            socket.destroy()
        }
    }

    /**
     * Channel 0 carries the data and channel 1 errors, each prefixed with a channel byte;
     * the first message of each channel is the port number
     */
    private pipe (socket: net.Socket, { ws, early, stopCollecting }: ForwardSocket): void {
        const seenPortHeader = [false, false]
        const onMessage = (data: Buffer) => {
            const channel = data[0]
            let payload = data.subarray(1)
            if (channel > 1) {
                return
            }
            if (!seenPortHeader[channel]) {
                seenPortHeader[channel] = true
                payload = payload.subarray(2)
            }
            if (!payload.length) {
                return
            }
            if (channel === 1) {
                // Such as "connection refused" from the pod
                this.resolved = null
                this.fail(payload.toString())
                socket.destroy()
            } else if (!socket.write(payload)) {
                ws.pause()
                socket.once('drain', () => ws.resume())
            }
        }
        stopCollecting()
        for (const data of early) {
            onMessage(data)
        }
        ws.on('message', onMessage)
        ws.on('close', () => socket.end())
        ws.on('error', e => {
            this.fail(e.message)
            socket.destroy()
        })

        socket.on('data', (chunk: Buffer) => {
            ws.send(Buffer.concat([Buffer.from([0]), chunk]), () => {
                if (socket.isPaused() && ws.bufferedAmount < MAX_BUFFERED) {
                    socket.resume()
                }
            })
            if (ws.bufferedAmount >= MAX_BUFFERED) {
                socket.pause()
            }
        })
        socket.on('close', () => ws.close())
        socket.resume()
    }

    private fail (message: string): void {
        this.error = message
        this.changed.next()
    }
}
