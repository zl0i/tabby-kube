import { dump } from 'js-yaml'
import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject, KubeTarget } from '../api'
import { loadKubeConfig } from './config'
import { KubeApiError, kubeJson } from './http'
import { findKind, KubeResourceKind, resourcePath } from './resources'
import { ResourceWatcher } from './watcher'

/** A connection to the cluster of one kubeconfig context */
export class KubeCluster {
    readonly kc: KubeConfig

    constructor (target: KubeTarget) {
        this.kc = loadKubeConfig(target)
    }

    get contextName (): string {
        return this.kc.getCurrentContext()
    }

    /** The namespace the context sets, if any */
    get contextNamespace (): string {
        return this.kc.getContextObject(this.contextName)?.namespace ?? ''
    }

    /** Checks that the cluster answers and the credentials work */
    async getVersion (): Promise<string> {
        const version = await kubeJson<{ gitVersion: string }>(this.kc, 'GET', '/version')
        return version.gitVersion
    }

    /** Namespace names; null when the credentials may not list them */
    async listNamespaces (): Promise<string[]|null> {
        try {
            const list = await kubeJson<{ items: KubeObject[] }>(this.kc, 'GET', resourcePath(findKind('namespaces')!, null))
            return list.items.map(x => x.metadata.name).sort()
        } catch (e) {
            if (e instanceof KubeApiError && e.statusCode === 403) {
                return null
            }
            throw e
        }
    }

    watch (kind: KubeResourceKind, namespace: string|null): ResourceWatcher {
        const watcher = new ResourceWatcher(this.kc, kind, namespace)
        watcher.start()
        return watcher
    }

    async read (kind: KubeResourceKind, obj: KubeObject): Promise<KubeObject> {
        return kubeJson(this.kc, 'GET', resourcePath(kind, obj.metadata.namespace ?? null, obj.metadata.name))
    }

    /**
     * Replaces the object with an edited one. Its resourceVersion has to be the current one,
     * otherwise the server refuses with 409 Conflict. A dry run checks the change without making it.
     */
    async replace (kind: KubeResourceKind, obj: KubeObject, options: { dryRun?: boolean } = {}): Promise<KubeObject> {
        return kubeJson(this.kc, 'PUT', resourcePath(kind, obj.metadata.namespace ?? null, obj.metadata.name), {
            body: obj,
            query: { dryRun: options.dryRun ? 'All' : undefined, fieldManager: 'tabby-kube' },
        })
    }

    async delete (kind: KubeResourceKind, obj: KubeObject): Promise<void> {
        await kubeJson(this.kc, 'DELETE', resourcePath(kind, obj.metadata.namespace ?? null, obj.metadata.name), {
            body: { propagationPolicy: 'Background' },
        })
    }

    /** Restarts the pods of a workload, as `kubectl rollout restart` does */
    async restart (kind: KubeResourceKind, obj: KubeObject): Promise<void> {
        await this.patch(kind, obj, {
            spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() } } } },
        })
    }

    async scale (kind: KubeResourceKind, obj: KubeObject, replicas: number): Promise<void> {
        await this.patch(kind, obj, { spec: { replicas } })
    }

    private async patch (kind: KubeResourceKind, obj: KubeObject, patch: unknown): Promise<void> {
        await kubeJson(this.kc, 'PATCH', resourcePath(kind, obj.metadata.namespace ?? null, obj.metadata.name), {
            body: patch,
            contentType: 'application/merge-patch+json',
        })
    }
}

/** The object as YAML, without the bookkeeping kubectl hides too */
export function toYaml (kind: KubeResourceKind, obj: KubeObject): string {
    const metadata: any = { ...obj.metadata }
    delete metadata.managedFields
    return dump({ apiVersion: kind.apiVersion, kind: kind.kind, ...obj, metadata }, { noRefs: true, lineWidth: -1 })
}
