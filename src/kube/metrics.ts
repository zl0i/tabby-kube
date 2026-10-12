import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { KubeApiError, kubeJson } from './http'
import { KubeColumn, Tone } from './resources'

const SUFFIXES: Record<string, number> = {
    n: 1e-9, u: 1e-6, m: 1e-3, '': 1,
    k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60,
}

/** A resource quantity ("250m", "1.5", "512Mi", "1234567n") in base units: cores or bytes */
export function parseQuantity (quantity: string|undefined): number {
    const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(quantity?.trim() ?? '')
    if (!match || !(match[2] in SUFFIXES)) {
        return 0
    }
    return Number(match[1]) * SUFFIXES[match[2]]
}

/** CPU as kubectl top prints it, in millicores */
export function formatCpu (cores: number): string {
    return `${Math.round(cores * 1000)}m`
}

export function formatMemory (bytes: number): string {
    if (bytes >= 10 * 2 ** 30) {
        return `${(bytes / 2 ** 30).toFixed(1)}Gi`
    }
    return `${Math.round(bytes / 2 ** 20)}Mi`
}

export interface Usage {
    cpu: number
    memory: number
}


function usageKey (obj: { metadata: { name: string, namespace?: string } }): string {
    return obj.metadata.namespace ? `${obj.metadata.namespace}/${obj.metadata.name}` : obj.metadata.name
}

/** Usage by "namespace/name" of pods, or by name of nodes; null when the cluster has no metrics API */
async function fetchUsage (kc: KubeConfig, apiPath: string): Promise<Map<string, Usage>|null> {
    const list = await kubeJson<{ items: any[] }>(kc, 'GET', `/apis/metrics.k8s.io/v1beta1${apiPath}`).catch(e => {
        // No metrics-server, or it isn't serving yet
        if (e instanceof KubeApiError && [403, 404, 503].includes(e.statusCode)) {
            return null
        }
        throw e
    })
    if (!list) {
        return null
    }
    const usage = new Map<string, Usage>()
    for (const item of list.items) {
        const parts: any[] = item.containers ?? [item]
        usage.set(usageKey(item), {
            cpu: parts.reduce((sum, x) => sum + parseQuantity(x.usage?.cpu), 0),
            memory: parts.reduce((sum, x) => sum + parseQuantity(x.usage?.memory), 0),
        })
    }
    return usage
}

export function fetchPodUsage (kc: KubeConfig, namespace: string|null): Promise<Map<string, Usage>|null> {
    return fetchUsage(kc, namespace ? `/namespaces/${encodeURIComponent(namespace)}/pods` : '/pods')
}

export function fetchNodeUsage (kc: KubeConfig): Promise<Map<string, Usage>|null> {
    return fetchUsage(kc, '/nodes')
}

function shareTone (share: number): Tone|null {
    if (share >= 0.9) {
        return 'error'
    }
    return share >= 0.75 ? 'warning' : null
}

/**
 * CPU and memory columns, from usage polled separately. Nodes also show the share of what they can
 * allocate to pods, colored when it runs high.
 */
export function usageColumns (kindId: string, getUsage: () => Map<string, Usage>|null): KubeColumn[] {
    const usageOf = (obj: KubeObject) => getUsage()?.get(usageKey(obj))
    const column = (title: string, resource: keyof Usage, format: (value: number) => string): KubeColumn => {
        const share = (obj: KubeObject) => {
            const used = usageOf(obj)?.[resource]
            const allocatable = parseQuantity(obj.status?.allocatable?.[resource])
            return used !== undefined && allocatable ? used / allocatable : null
        }
        return {
            title,
            value: obj => {
                const used = usageOf(obj)?.[resource]
                if (used === undefined) {
                    return ''
                }
                const fraction = kindId === 'nodes' ? share(obj) : null
                return fraction !== null ? `${format(used)} (${Math.round(fraction * 100)}%)` : format(used)
            },
            sortValue: obj => usageOf(obj)?.[resource] ?? -1,
            tone: kindId === 'nodes' ? obj => shareTone(share(obj) ?? 0) : undefined,
        }
    }
    return [column('CPU', 'cpu', formatCpu), column('Memory', 'memory', formatMemory)]
}

export function hasUsage (kindId: string): boolean {
    return kindId === 'pods' || kindId === 'nodes'
}
