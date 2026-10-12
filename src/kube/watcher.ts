import { createInterface } from 'readline'
import { Observable, Subject } from 'rxjs'
import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { kubeJson, kubeRequest } from './http'
import { KubeResourceKind, resourcePath } from './resources'

const RETRY_DELAY = 5000
/** The server ends a watch after this; it is then resumed from the last seen version */
const WATCH_TIMEOUT_SECONDS = 300

interface WatchEvent {
    type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR'
    object: any
}

/**
 * Keeps a live copy of a collection: lists it, then follows a watch from the listed version.
 * Lists again when the watch can't be resumed (the version expired) or fails.
 */
export class ResourceWatcher {
    /** Whether the first list has arrived */
    loaded = false
    /** The last failure; the watcher keeps retrying, and the items stay as they were */
    error: string|null = null
    private objects = new Map<string, KubeObject>()
    private resourceVersion = ''
    private abort: AbortController|null = null
    private retryTimer: ReturnType<typeof setTimeout>|null = null
    private stopped = false
    private changed = new Subject<void>()

    /** Fires on every change, including errors; consumers should throttle it */
    get changed$ (): Observable<void> { return this.changed }

    get items (): KubeObject[] {
        return [...this.objects.values()]
    }

    constructor (
        private kc: KubeConfig,
        public readonly kind: KubeResourceKind,
        /** Null means all namespaces */
        public readonly namespace: string|null,
    ) { }

    start (): void {
        this.list()
    }

    stop (): void {
        this.stopped = true
        this.abort?.abort()
        if (this.retryTimer) {
            clearTimeout(this.retryTimer)
        }
        this.changed.complete()
    }

    private get path (): string {
        return resourcePath(this.kind, this.namespace)
    }

    private async list (): Promise<void> {
        this.abort = new AbortController()
        try {
            const list = await kubeJson<{ items: KubeObject[], metadata: { resourceVersion: string } }>(
                this.kc, 'GET', this.path, { signal: this.abort.signal },
            )
            if (this.stopped) {
                return
            }
            this.objects = new Map(list.items.map(x => [x.metadata.uid, x]))
            this.resourceVersion = list.metadata.resourceVersion
            this.loaded = true
            this.error = null
            this.changed.next()
        } catch (e) {
            this.fail(e)
            return
        }
        this.watch()
    }

    private async watch (): Promise<void> {
        this.abort = new AbortController()
        let expired = false
        try {
            const response = await kubeRequest(this.kc, 'GET', this.path, {
                query: {
                    watch: true,
                    resourceVersion: this.resourceVersion,
                    allowWatchBookmarks: true,
                    timeoutSeconds: WATCH_TIMEOUT_SECONDS,
                },
                signal: this.abort.signal,
            })
            const lines = createInterface(response)
            for await (const line of lines) {
                if (this.stopped) {
                    return
                }
                if (!line.trim()) {
                    continue
                }
                const event: WatchEvent = JSON.parse(line)
                if (event.type === 'ERROR') {
                    // 410 Gone: the version is too old to resume from
                    expired = true
                    break
                }
                this.apply(event)
            }
        } catch (e) {
            this.fail(e)
            return
        }
        if (this.stopped) {
            return
        }
        if (expired) {
            this.list()
        } else {
            this.watch()
        }
    }

    private apply (event: WatchEvent): void {
        const obj: KubeObject = event.object
        this.resourceVersion = obj.metadata.resourceVersion ?? this.resourceVersion
        if (event.type === 'ADDED' || event.type === 'MODIFIED') {
            this.objects.set(obj.metadata.uid, obj)
        } else if (event.type === 'DELETED') {
            this.objects.delete(obj.metadata.uid)
        } else {
            return
        }
        this.changed.next()
    }

    private fail (e: any): void {
        if (this.stopped) {
            return
        }
        this.error = e?.message ?? String(e)
        this.changed.next()
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.list()
        }, RETRY_DELAY)
    }
}
