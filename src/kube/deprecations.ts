import { loadAll } from 'js-yaml'

export interface KubeVersion {
    major: number
    minor: number
}

export interface ApiDeprecation {
    apiVersion: string
    kind: string
    deprecatedIn: string
    /** Null while no removal is planned */
    removedIn: string|null
    /** The apiVersion to move to; null when the kind is gone for good */
    replacement: string|null
}

function entries (apiVersion: string, kinds: string[], deprecatedIn: string, removedIn: string|null, replacement: string|null): ApiDeprecation[] {
    return kinds.map(kind => ({ apiVersion, kind, deprecatedIn, removedIn, replacement }))
}

/** From the Kubernetes deprecated API migration guide */
export const API_DEPRECATIONS: ApiDeprecation[] = [
    // Removed in 1.16
    ...entries('extensions/v1beta1', ['Deployment', 'DaemonSet', 'ReplicaSet'], '1.9', '1.16', 'apps/v1'),
    ...entries('extensions/v1beta1', ['NetworkPolicy'], '1.9', '1.16', 'networking.k8s.io/v1'),
    ...entries('extensions/v1beta1', ['PodSecurityPolicy'], '1.10', '1.16', 'policy/v1beta1'),
    ...entries('apps/v1beta1', ['Deployment', 'StatefulSet', 'ReplicaSet'], '1.9', '1.16', 'apps/v1'),
    ...entries('apps/v1beta2', ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'], '1.9', '1.16', 'apps/v1'),
    // Removed in 1.22
    ...entries('admissionregistration.k8s.io/v1beta1', ['MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration'], '1.16', '1.22', 'admissionregistration.k8s.io/v1'),
    ...entries('apiextensions.k8s.io/v1beta1', ['CustomResourceDefinition'], '1.16', '1.22', 'apiextensions.k8s.io/v1'),
    ...entries('apiregistration.k8s.io/v1beta1', ['APIService'], '1.19', '1.22', 'apiregistration.k8s.io/v1'),
    ...entries('authentication.k8s.io/v1beta1', ['TokenReview'], '1.19', '1.22', 'authentication.k8s.io/v1'),
    ...entries('authorization.k8s.io/v1beta1', ['SubjectAccessReview', 'LocalSubjectAccessReview', 'SelfSubjectAccessReview'], '1.19', '1.22', 'authorization.k8s.io/v1'),
    ...entries('certificates.k8s.io/v1beta1', ['CertificateSigningRequest'], '1.19', '1.22', 'certificates.k8s.io/v1'),
    ...entries('coordination.k8s.io/v1beta1', ['Lease'], '1.19', '1.22', 'coordination.k8s.io/v1'),
    ...entries('extensions/v1beta1', ['Ingress'], '1.14', '1.22', 'networking.k8s.io/v1'),
    ...entries('networking.k8s.io/v1beta1', ['Ingress', 'IngressClass'], '1.19', '1.22', 'networking.k8s.io/v1'),
    ...entries('rbac.authorization.k8s.io/v1beta1', ['ClusterRole', 'ClusterRoleBinding', 'Role', 'RoleBinding'], '1.17', '1.22', 'rbac.authorization.k8s.io/v1'),
    ...entries('scheduling.k8s.io/v1beta1', ['PriorityClass'], '1.14', '1.22', 'scheduling.k8s.io/v1'),
    ...entries('storage.k8s.io/v1beta1', ['CSIDriver', 'CSINode', 'StorageClass', 'VolumeAttachment'], '1.19', '1.22', 'storage.k8s.io/v1'),
    // Removed in 1.25
    ...entries('batch/v1beta1', ['CronJob'], '1.21', '1.25', 'batch/v1'),
    ...entries('discovery.k8s.io/v1beta1', ['EndpointSlice'], '1.21', '1.25', 'discovery.k8s.io/v1'),
    ...entries('events.k8s.io/v1beta1', ['Event'], '1.19', '1.25', 'events.k8s.io/v1'),
    ...entries('autoscaling/v2beta1', ['HorizontalPodAutoscaler'], '1.22', '1.25', 'autoscaling/v2'),
    ...entries('policy/v1beta1', ['PodDisruptionBudget'], '1.21', '1.25', 'policy/v1'),
    ...entries('policy/v1beta1', ['PodSecurityPolicy'], '1.21', '1.25', null),
    ...entries('node.k8s.io/v1beta1', ['RuntimeClass'], '1.20', '1.25', 'node.k8s.io/v1'),
    // Removed in 1.26
    ...entries('flowcontrol.apiserver.k8s.io/v1beta1', ['FlowSchema', 'PriorityLevelConfiguration'], '1.23', '1.26', 'flowcontrol.apiserver.k8s.io/v1'),
    ...entries('autoscaling/v2beta2', ['HorizontalPodAutoscaler'], '1.23', '1.26', 'autoscaling/v2'),
    // Removed in 1.27
    ...entries('storage.k8s.io/v1beta1', ['CSIStorageCapacity'], '1.24', '1.27', 'storage.k8s.io/v1'),
    // Removed in 1.29
    ...entries('flowcontrol.apiserver.k8s.io/v1beta2', ['FlowSchema', 'PriorityLevelConfiguration'], '1.26', '1.29', 'flowcontrol.apiserver.k8s.io/v1'),
    // Removed in 1.32
    ...entries('flowcontrol.apiserver.k8s.io/v1beta3', ['FlowSchema', 'PriorityLevelConfiguration'], '1.29', '1.32', 'flowcontrol.apiserver.k8s.io/v1'),
    // Deprecated, no removal planned
    ...entries('v1', ['Endpoints'], '1.33', null, 'discovery.k8s.io/v1'),
]

/** "v1.32.13+k3s1", "1.25" */
export function parseVersion (version: string): KubeVersion|null {
    const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
    return match ? { major: Number(match[1]), minor: Number(match[2]) } : null
}

export function compareVersions (a: KubeVersion, b: KubeVersion): number {
    return a.major - b.major || a.minor - b.minor
}

export function formatVersion (version: KubeVersion): string {
    return `${version.major}.${version.minor}`
}

/** Whether the change of a version has happened by another version */
function reached (version: string|null, by: KubeVersion): boolean {
    const parsed = version ? parseVersion(version) : null
    return !!parsed && compareVersions(parsed, by) <= 0
}

export function findDeprecation (apiVersion: string, kind: string): ApiDeprecation|undefined {
    return API_DEPRECATIONS.find(x => x.apiVersion === apiVersion && x.kind === kind)
}

/** Where a use of an API was found */
export type ApiUsageSource = 'helm' | 'applied' | 'requested'

export interface ApiUsage {
    apiVersion: string
    kind: string
    /** The object; empty for API requests, which the API server counts by resource */
    name: string
    namespace?: string
    source: ApiUsageSource
    /** For Helm: the release whose current manifest has the object */
    release?: { namespace: string, name: string, revision: number }
    /** For requests: the API server's own word on when the API goes */
    removedRelease?: string
    /** What to show in the cluster tab for it: an object of a kind there */
    link?: { kindId: string, uid: string, namespace?: string }
}

/** What the cluster serves, to judge the APIs against */
export interface ApiCheckContext {
    version: KubeVersion
    /** groupVersions served, as "apps/v1"; null when discovery failed */
    served: Set<string>|null
    /** Versions their CRDs mark deprecated: "group/version/Kind" to the CRD's warning */
    deprecatedCustom: Map<string, string>
}

/**
 * - `removed`: not served by the cluster (any more): applying it fails, and so does `helm upgrade`
 *   of a release whose stored manifest has it
 * - `removed-in-target`: still served, but not by the version being upgraded to
 * - `deprecated`: served, to be removed some day
 */
export type ApiStatus = 'removed' | 'removed-in-target' | 'deprecated'

export interface ApiFinding extends ApiUsage {
    status: ApiStatus
    detail: string
    replacement: string|null
}

/** Judges one use of an API by the cluster's version and APIs, and a version to upgrade to */
export function checkUsage (usage: ApiUsage, context: ApiCheckContext, target: KubeVersion = context.version): ApiFinding|null {
    const entry = findDeprecation(usage.apiVersion, usage.kind)
    const replacement = entry?.replacement ?? null
    const finding = (status: ApiStatus, detail: string): ApiFinding => ({ ...usage, status, detail, replacement })

    if (usage.source === 'requested') {
        // Deprecated by the API server's own word, which serves it still
        if (!usage.removedRelease) {
            return finding('deprecated', 'Deprecated, no removal planned')
        }
        return reached(usage.removedRelease, target)
            ? finding('removed-in-target', `Removed in ${usage.removedRelease}`)
            : finding('deprecated', `Deprecated, removed in ${usage.removedRelease}`)
    }
    if (context.served && !context.served.has(usage.apiVersion)) {
        return finding('removed', entry?.removedIn ? `Removed in ${entry.removedIn}` : 'Not served by this cluster')
    }
    if (entry) {
        if (reached(entry.removedIn, context.version)) {
            return finding('removed', `Removed in ${entry.removedIn}`)
        }
        if (reached(entry.removedIn, target)) {
            return finding('removed-in-target', `Removed in ${entry.removedIn}`)
        }
        if (reached(entry.deprecatedIn, context.version)) {
            return finding('deprecated', `Deprecated in ${entry.deprecatedIn}${entry.removedIn ? `, removed in ${entry.removedIn}` : ''}`)
        }
    }
    const custom = context.deprecatedCustom.get(`${usage.apiVersion}/${usage.kind}`)
    return custom !== undefined ? finding('deprecated', custom) : null
}

export interface ManifestResource {
    apiVersion: string
    kind: string
    name: string
    namespace?: string
}

/** The objects of a multi-document manifest, as Helm stores a release's */
function yamlDocuments (text: string): unknown[] {
    try {
        return loadAll(text)
    } catch {
        return []
    }
}

export function manifestResources (manifest: string): ManifestResource[] {
    return yamlDocuments(manifest)
        .filter((x): x is Record<string, any> => !!x && typeof x === 'object' && typeof (x as any).apiVersion === 'string' && typeof (x as any).kind === 'string')
        .map(x => ({ apiVersion: x.apiVersion, kind: x.kind, name: x.metadata?.name ?? '', namespace: x.metadata?.namespace }))
}

/**
 * Lines of apiserver_requested_deprecated_apis from the API server's metrics:
 * deprecated APIs requested since it started, with the release that removes them
 */
export function parseRequestedDeprecatedApis (metrics: string): ApiUsage[] {
    const usages: ApiUsage[] = []
    for (const line of metrics.split('\n')) {
        // A gauge: 1 for each deprecated API requested since the API server started
        const match = /^apiserver_requested_deprecated_apis\{([^}]*)\}\s+1\b/.exec(line)
        if (!match) {
            continue
        }
        const labels = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]))
        usages.push({
            apiVersion: labels.group ? `${labels.group}/${labels.version}` : labels.version,
            kind: labels.resource + (labels.subresource ? `/${labels.subresource}` : ''),
            name: '',
            source: 'requested',
            removedRelease: labels.removed_release || undefined,
        })
    }
    return usages
}
