import * as zlib from 'zlib'
import { KubeObject } from '../api'

/**
 * Helm 3 keeps each revision of a release in a secret of its namespace, labeled owner=helm with the
 * release's name, revision and status. Superseded revisions are history; the others are current.
 */
export const HELM_CURRENT_SELECTOR = 'owner=helm,status!=superseded,status!=uninstalled'

export function helmHistorySelector (release: string): string {
    return `owner=helm,name=${release}`
}

export interface HelmRelease {
    name: string
    namespace: string
    version: number
    info: {
        status: string
        first_deployed?: string
        last_deployed?: string
        description?: string
        notes?: string
    }
    chart: {
        metadata: { name: string, version: string, appVersion?: string, description?: string }
        values?: Record<string, unknown>
    }
    /** The values given to the release, over the chart's defaults */
    config?: Record<string, unknown>
    manifest?: string
}

const MAX_CACHED = 300
const cache = new Map<string, HelmRelease|null>()

/** The release a Helm secret holds: base64 (the secret's own) of base64 of gzipped JSON */
export function decodeRelease (secret: KubeObject): HelmRelease|null {
    const key = `${secret.metadata.uid}@${secret.metadata.resourceVersion}`
    if (cache.has(key)) {
        return cache.get(key)!
    }
    let release: HelmRelease|null = null
    if (!secret.data?.release) {
        return null
    }
    try {
        const encoded = Buffer.from(secret.data?.release ?? '', 'base64').toString('utf-8')
        let data = Buffer.from(encoded, 'base64')
        // gzip's magic bytes; Helm wrote plain JSON before it compressed releases
        if (data[0] === 0x1f && data[1] === 0x8b) {
            data = zlib.gunzipSync(data)
        }
        release = JSON.parse(data.toString('utf-8'))
    } catch (e) {
        console.warn(`Could not decode the Helm release in ${secret.metadata.name}`, e)
    }
    if (cache.size >= MAX_CACHED) {
        cache.delete(cache.keys().next().value!)
    }
    cache.set(key, release)
    return release
}

export function helmRevision (secret: KubeObject): number {
    return Number(secret.metadata.labels?.version ?? 0)
}

/**
 * The newest revision of each release: a failed upgrade leaves the revision before it deployed,
 * and both are current by their labels
 */
export function latestRevisions (secrets: KubeObject[]): KubeObject[] {
    const latest = new Map<string, KubeObject>()
    for (const secret of secrets) {
        const key = `${secret.metadata.namespace}/${secret.metadata.labels?.name}`
        const current = latest.get(key)
        if (!current || helmRevision(secret) > helmRevision(current)) {
            latest.set(key, secret)
        }
    }
    return [...latest.values()]
}

export function helmStatusTone (status: string|undefined): 'ok' | 'warning' | 'error' | 'muted' | null {
    if (status === 'deployed') {
        return 'ok'
    }
    if (status === 'failed') {
        return 'error'
    }
    if (status?.startsWith('pending')) {
        return 'warning'
    }
    return status === 'superseded' ? 'muted' : null
}

export function chartLabel (release: HelmRelease|null): string {
    return release ? `${release.chart.metadata.name}-${release.chart.metadata.version}` : ''
}
