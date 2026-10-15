import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { ApiCheckContext, ApiFinding, ApiUsage, checkUsage, manifestResources, parseRequestedDeprecatedApis, parseVersion } from './deprecations'
import { decodeRelease, HELM_CURRENT_SELECTOR, latestRevisions } from './helm'
import { KubeApiError, kubeJson, kubeTextLines } from './http'
import type { KubeColumn } from './resources'

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
/** Lists metadata only: the annotations, without the objects' specs */
const METADATA_ONLY = 'application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1'

interface ScannedKind {
    apiVersion: string
    plural: string
    kind: string
    /** The cluster tab's kind, to show a found object in */
    kindId?: string
}

/**
 * Kinds that had other API versions, listed at their current ones: what was applied with
 * an old version still says so in its last-applied annotation
 */
const SCANNED_KINDS: ScannedKind[] = [
    { apiVersion: 'apps/v1', plural: 'deployments', kind: 'Deployment', kindId: 'deployments' },
    { apiVersion: 'apps/v1', plural: 'statefulsets', kind: 'StatefulSet', kindId: 'statefulsets' },
    { apiVersion: 'apps/v1', plural: 'daemonsets', kind: 'DaemonSet', kindId: 'daemonsets' },
    { apiVersion: 'batch/v1', plural: 'cronjobs', kind: 'CronJob', kindId: 'cronjobs' },
    { apiVersion: 'networking.k8s.io/v1', plural: 'ingresses', kind: 'Ingress', kindId: 'ingresses' },
    { apiVersion: 'networking.k8s.io/v1', plural: 'ingressclasses', kind: 'IngressClass' },
    { apiVersion: 'networking.k8s.io/v1', plural: 'networkpolicies', kind: 'NetworkPolicy' },
    { apiVersion: 'autoscaling/v2', plural: 'horizontalpodautoscalers', kind: 'HorizontalPodAutoscaler' },
    { apiVersion: 'policy/v1', plural: 'poddisruptionbudgets', kind: 'PodDisruptionBudget' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', plural: 'clusterroles', kind: 'ClusterRole' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', plural: 'clusterrolebindings', kind: 'ClusterRoleBinding' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', plural: 'roles', kind: 'Role' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', plural: 'rolebindings', kind: 'RoleBinding' },
    { apiVersion: 'scheduling.k8s.io/v1', plural: 'priorityclasses', kind: 'PriorityClass' },
    { apiVersion: 'storage.k8s.io/v1', plural: 'storageclasses', kind: 'StorageClass' },
    { apiVersion: 'storage.k8s.io/v1', plural: 'csidrivers', kind: 'CSIDriver' },
    { apiVersion: 'admissionregistration.k8s.io/v1', plural: 'mutatingwebhookconfigurations', kind: 'MutatingWebhookConfiguration' },
    { apiVersion: 'admissionregistration.k8s.io/v1', plural: 'validatingwebhookconfigurations', kind: 'ValidatingWebhookConfiguration' },
    { apiVersion: 'apiextensions.k8s.io/v1', plural: 'customresourcedefinitions', kind: 'CustomResourceDefinition' },
    { apiVersion: 'apiregistration.k8s.io/v1', plural: 'apiservices', kind: 'APIService' },
    { apiVersion: 'node.k8s.io/v1', plural: 'runtimeclasses', kind: 'RuntimeClass' },
    { apiVersion: 'flowcontrol.apiserver.k8s.io/v1', plural: 'flowschemas', kind: 'FlowSchema' },
    { apiVersion: 'flowcontrol.apiserver.k8s.io/v1', plural: 'prioritylevelconfigurations', kind: 'PriorityLevelConfiguration' },
]

function isRefused (e: unknown): boolean {
    return e instanceof KubeApiError && [401, 403, 404, 503].includes(e.statusCode)
}

/** The cluster's version, the API versions it serves, and the custom versions their CRDs deprecate */
export async function loadApiContext (kc: KubeConfig, gitVersion: string): Promise<ApiCheckContext> {
    let served: Set<string>|null = null
    try {
        const core = await kubeJson<{ versions: string[] }>(kc, 'GET', '/api')
        const groups = await kubeJson<{ groups: { versions: { groupVersion: string }[] }[] }>(kc, 'GET', '/apis')
        served = new Set([...core.versions, ...groups.groups.flatMap(g => g.versions.map(v => v.groupVersion))])
    } catch (e) {
        console.warn('Could not discover the served API versions', e)
    }
    const deprecatedCustom = new Map<string, string>()
    try {
        const crds = await kubeJson<{ items: KubeObject[] }>(kc, 'GET', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
        for (const crd of crds.items) {
            for (const version of crd.spec?.versions ?? []) {
                if (version.deprecated && version.served) {
                    deprecatedCustom.set(
                        `${crd.spec.group}/${version.name}/${crd.spec.names.kind}`,
                        version.deprecationWarning ?? `Deprecated by its definition, ${crd.metadata.name}`,
                    )
                }
            }
        }
    } catch (e) {
        if (!isRefused(e)) {
            throw e
        }
    }
    return { version: parseVersion(gitVersion) ?? { major: 1, minor: 0 }, served, deprecatedCustom }
}

const MAX_CACHED = 300
const releaseUsageCache = new Map<string, ApiUsage[]>()

/** The objects in a Helm release's stored manifest, decoded once per version of its secret */
export function releaseApiUsage (secret: KubeObject): ApiUsage[] {
    const key = `${secret.metadata.uid}@${secret.metadata.resourceVersion}`
    let usages = releaseUsageCache.get(key)
    if (!usages) {
        const release = decodeRelease(secret)
        usages = release ? manifestResources(release.manifest ?? '').map(resource => ({
            // Without one in the manifest, namespaced objects go to the release's namespace and cluster-wide ones to none
            ...resource,
            source: 'helm',
            release: { namespace: release.namespace, name: release.name, revision: release.version },
            link: { kindId: 'helmreleases', uid: secret.metadata.uid, namespace: secret.metadata.namespace },
        })) : []
        if (releaseUsageCache.size >= MAX_CACHED) {
            releaseUsageCache.delete(releaseUsageCache.keys().next().value!)
        }
        releaseUsageCache.set(key, usages)
    }
    return usages
}

/** The old APIs in a Helm release's stored manifest */
export function releaseApiFindings (secret: KubeObject, context: ApiCheckContext): ApiFinding[] {
    return releaseApiUsage(secret).map(x => checkUsage(x, context)).filter((x): x is ApiFinding => !!x)
}

/** For the Helm releases table: what in a release's manifest is removed or deprecated */
export function helmApiColumn (getContext: () => ApiCheckContext|null): KubeColumn {
    const findings = (secret: KubeObject) => {
        const context = getContext()
        return context ? releaseApiFindings(secret, context) : []
    }
    return {
        title: 'APIs',
        value: secret => {
            const found = findings(secret)
            const removed = found.filter(x => x.status === 'removed').length
            const deprecated = found.length - removed
            return [removed ? `${removed} removed` : '', deprecated ? `${deprecated} deprecated` : ''].filter(x => x).join(', ')
        },
        tone: secret => {
            const found = findings(secret)
            return found.some(x => x.status === 'removed') ? 'error' : found.length ? 'warning' : null
        },
        sortValue: secret => -findings(secret).reduce((sum, x) => sum + (x.status === 'removed' ? 100 : 1), 0),
    }
}

export interface ApiScan {
    usages: ApiUsage[]
    /** Sources the credentials may not read, or the cluster doesn't offer */
    unavailable: string[]
}

async function scanHelm (kc: KubeConfig): Promise<ApiUsage[]> {
    const secrets = await kubeJson<{ items: KubeObject[]|null }>(kc, 'GET', '/api/v1/secrets', { query: { labelSelector: HELM_CURRENT_SELECTOR } })
    return latestRevisions(secrets.items ?? []).flatMap(releaseApiUsage)
}

/** The apiVersion of the manifest kubectl applied last, from its annotation */
function appliedApiVersion (annotation: string|undefined): string|null {
    if (!annotation) {
        return null
    }
    try {
        const apiVersion = JSON.parse(annotation).apiVersion
        return typeof apiVersion === 'string' ? apiVersion : null
    } catch {
        return null
    }
}

async function scanApplied (kc: KubeConfig, scanned: ScannedKind): Promise<ApiUsage[]> {
    const base = scanned.apiVersion.includes('/') ? `/apis/${scanned.apiVersion}` : `/api/${scanned.apiVersion}`
    const list = await kubeJson<{ items: KubeObject[]|null }>(kc, 'GET', `${base}/${scanned.plural}`, { accept: METADATA_ONLY })
    const usages: ApiUsage[] = []
    // Empty metadata lists come with null items
    for (const item of list.items ?? []) {
        const apiVersion = appliedApiVersion(item.metadata.annotations?.[LAST_APPLIED])
        if (apiVersion && apiVersion !== scanned.apiVersion) {
            usages.push({
                apiVersion,
                kind: scanned.kind,
                name: item.metadata.name,
                namespace: item.metadata.namespace,
                source: 'applied',
                link: scanned.kindId ? { kindId: scanned.kindId, uid: item.metadata.uid, namespace: item.metadata.namespace } : undefined,
            })
        }
    }
    return usages
}

/** Finds the API versions in use: in Helm releases, in what kubectl applied, and in requests to the API server */
export async function scanApiUsage (kc: KubeConfig): Promise<ApiScan> {
    const unavailable: string[] = []
    const tolerate = (source: string) => (e: unknown): ApiUsage[] => {
        if (isRefused(e)) {
            unavailable.push(source)
            return []
        }
        throw e
    }
    const results = await Promise.all([
        scanHelm(kc).catch(tolerate('Helm releases')),
        ...SCANNED_KINDS.map(x => scanApplied(kc, x).catch(e => {
            // A kind the cluster doesn't have, or may not be listed
            if (isRefused(e)) {
                return []
            }
            throw e
        })),
        kubeTextLines(kc, '/metrics', x => x.startsWith('apiserver_requested_deprecated_apis{'))
            .then(lines => parseRequestedDeprecatedApis(lines.join('\n')))
            .catch(tolerate('API server metrics')),
    ])
    return { usages: results.flat(), unavailable }
}
