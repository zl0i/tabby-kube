import { KubeObject } from '../api'

export type Tone = 'ok' | 'warning' | 'error' | 'muted'

export interface KubeColumn {
    title: string
    value: (obj: KubeObject) => string
    /** Colors the cell */
    tone?: (obj: KubeObject) => Tone|null
    /** Sorts by this instead of the displayed text */
    sortValue?: (obj: KubeObject) => number|string
    /** Takes the space left over by the other columns */
    wide?: boolean
}

export interface KubeResourceKind {
    id: string
    title: string
    section: string
    /** API group of a custom resource, to group them by */
    group?: string
    apiVersion: string
    kind: string
    plural: string
    namespaced: boolean
    columns: KubeColumn[]
    /** Whether pods it owns can be restarted with a rollout */
    restartable?: boolean
    /** Whether it has spec.replicas */
    scalable?: boolean
    /** Objects with generated names (events) leave the name column out */
    hideName?: boolean
    /** Initial sort; the name otherwise */
    defaultSort?: { column: string, descending: boolean }
}

// Formatting

/** The age the way kubectl prints it: 45s, 7m12s, 5h, 3d4h, 120d */
export function formatAge (timestamp: string|undefined, now = Date.now()): string {
    if (!timestamp) {
        return ''
    }
    const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000))
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    if (seconds < 120) {
        return `${seconds}s`
    }
    if (minutes < 10) {
        return seconds % 60 ? `${minutes}m${seconds % 60}s` : `${minutes}m`
    }
    if (hours < 3) {
        return `${minutes}m`
    }
    if (hours < 8) {
        return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`
    }
    if (hours < 48) {
        return `${hours}h`
    }
    if (days < 8) {
        return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`
    }
    if (days < 365 * 2) {
        return `${days}d`
    }
    return `${Math.floor(days / 365)}y`
}

function timestampValue (timestamp: string|undefined): number {
    return timestamp ? new Date(timestamp).getTime() : 0
}

export const ageColumn: KubeColumn = {
    title: 'Age',
    value: obj => formatAge(obj.metadata.creationTimestamp),
    // Older first when ascending, as kubectl's --sort-by=.metadata.creationTimestamp
    sortValue: obj => -timestampValue(obj.metadata.creationTimestamp),
}

function count (value: unknown): string {
    return String(value ?? 0)
}

// Pods

/** The pod's status as `kubectl get pods` shows it */
export function podStatus (pod: KubeObject): string {
    if (pod.metadata.deletionTimestamp) {
        return 'Terminating'
    }
    let reason: string = pod.status?.reason || pod.status?.phase || 'Unknown'

    const initStatuses: any[] = pod.status?.initContainerStatuses ?? []
    const initCount = pod.spec?.initContainers?.length ?? initStatuses.length
    for (const [i, c] of initStatuses.entries()) {
        const terminated = c.state?.terminated
        if (terminated?.exitCode === 0) {
            continue
        }
        if (terminated) {
            return terminated.reason ? `Init:${terminated.reason}` : `Init:ExitCode:${terminated.exitCode}`
        }
        const waiting = c.state?.waiting?.reason
        if (waiting && waiting !== 'PodInitializing') {
            return `Init:${waiting}`
        }
        return `Init:${i}/${initCount}`
    }

    let hasRunning = false
    for (const c of [...pod.status?.containerStatuses ?? []].reverse()) {
        if (c.state?.waiting?.reason) {
            reason = c.state.waiting.reason
        } else if (c.state?.terminated) {
            reason = c.state.terminated.reason || (c.state.terminated.signal ? `Signal:${c.state.terminated.signal}` : `ExitCode:${c.state.terminated.exitCode}`)
        } else if (c.ready && c.state?.running) {
            hasRunning = true
        }
    }
    if (reason === 'Completed' && hasRunning) {
        reason = 'Running'
    }
    return reason
}

export function podReady (pod: KubeObject): [number, number] {
    const statuses: any[] = pod.status?.containerStatuses ?? []
    return [statuses.filter(x => x.ready).length, pod.spec?.containers?.length ?? statuses.length]
}

export function podRestarts (pod: KubeObject): number {
    return (pod.status?.containerStatuses ?? []).reduce((sum: number, c: any) => sum + (c.restartCount ?? 0), 0)
}

function podTone (pod: KubeObject): Tone {
    const status = podStatus(pod)
    if (status === 'Completed' || status === 'Succeeded') {
        return 'muted'
    }
    if (status === 'Running') {
        const [ready, total] = podReady(pod)
        return ready === total ? 'ok' : 'warning'
    }
    if (['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating'].includes(status) || /^Init:\d+\/\d+$/.test(status)) {
        return 'warning'
    }
    return 'error'
}

/** Containers that can run a shell or have logs, init containers last */
export function podContainers (pod: KubeObject): string[] {
    return [
        ...(pod.spec?.containers ?? []).map((c: any) => c.name),
        ...(pod.spec?.initContainers ?? []).map((c: any) => c.name),
    ]
}

// Workloads

function readyOf (ready: number|undefined, desired: number|undefined): string {
    return `${ready ?? 0}/${desired ?? 0}`
}

function replicasTone (ready: number|undefined, desired: number|undefined): Tone {
    return (ready ?? 0) === (desired ?? 0) ? 'ok' : 'warning'
}

// Nodes

function nodeStatus (node: KubeObject): string {
    const ready = (node.status?.conditions ?? []).find((c: any) => c.type === 'Ready')
    const status = ready?.status === 'True' ? 'Ready' : ready ? 'NotReady' : 'Unknown'
    return node.spec?.unschedulable ? `${status},SchedulingDisabled` : status
}

function nodeRoles (node: KubeObject): string {
    const roles = Object.keys(node.metadata.labels ?? {})
        .filter(x => x.startsWith('node-role.kubernetes.io/'))
        .map(x => x.slice('node-role.kubernetes.io/'.length))
    return roles.join(',') || '<none>'
}

// Services

function servicePorts (service: KubeObject): string {
    return (service.spec?.ports ?? [])
        .map((p: any) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol ?? 'TCP'}`)
        .join(',')
}

function serviceExternalIp (service: KubeObject): string {
    const ingress = (service.status?.loadBalancer?.ingress ?? []).map((x: any) => x.ip ?? x.hostname)
    return [...ingress, ...service.spec?.externalIPs ?? []].join(',') || (service.spec?.type === 'LoadBalancer' ? '<pending>' : '')
}

// Events

function eventTime (event: KubeObject): string|undefined {
    return event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp
}

export const RESOURCE_KINDS: KubeResourceKind[] = [
    {
        id: 'pods', title: 'Pods', section: 'Workloads',
        apiVersion: 'v1', kind: 'Pod', plural: 'pods', namespaced: true,
        columns: [
            {
                title: 'Ready',
                value: obj => podReady(obj).join('/'),
                tone: (obj: KubeObject): Tone|null => {
                    const [ready, total] = podReady(obj)
                    return ready === total ? null : 'warning'
                },
            },
            { title: 'Status', value: podStatus, tone: podTone },
            {
                title: 'Restarts',
                value: obj => count(podRestarts(obj)),
                sortValue: podRestarts,
            },
            { title: 'IP', value: obj => obj.status?.podIP ?? '' },
            { title: 'Node', value: obj => obj.spec?.nodeName ?? '' },
            ageColumn,
        ],
    },
    {
        id: 'deployments', title: 'Deployments', section: 'Workloads',
        apiVersion: 'apps/v1', kind: 'Deployment', plural: 'deployments', namespaced: true,
        restartable: true, scalable: true,
        columns: [
            {
                title: 'Ready',
                value: obj => readyOf(obj.status?.readyReplicas, obj.spec?.replicas),
                tone: obj => replicasTone(obj.status?.readyReplicas, obj.spec?.replicas),
            },
            { title: 'Up-to-date', value: obj => count(obj.status?.updatedReplicas) },
            { title: 'Available', value: obj => count(obj.status?.availableReplicas) },
            ageColumn,
        ],
    },
    {
        id: 'statefulsets', title: 'StatefulSets', section: 'Workloads',
        apiVersion: 'apps/v1', kind: 'StatefulSet', plural: 'statefulsets', namespaced: true,
        restartable: true, scalable: true,
        columns: [
            {
                title: 'Ready',
                value: obj => readyOf(obj.status?.readyReplicas, obj.spec?.replicas),
                tone: obj => replicasTone(obj.status?.readyReplicas, obj.spec?.replicas),
            },
            ageColumn,
        ],
    },
    {
        id: 'daemonsets', title: 'DaemonSets', section: 'Workloads',
        apiVersion: 'apps/v1', kind: 'DaemonSet', plural: 'daemonsets', namespaced: true,
        restartable: true,
        columns: [
            { title: 'Desired', value: obj => count(obj.status?.desiredNumberScheduled) },
            { title: 'Current', value: obj => count(obj.status?.currentNumberScheduled) },
            {
                title: 'Ready',
                value: obj => count(obj.status?.numberReady),
                tone: obj => replicasTone(obj.status?.numberReady, obj.status?.desiredNumberScheduled),
            },
            ageColumn,
        ],
    },
    {
        id: 'jobs', title: 'Jobs', section: 'Workloads',
        apiVersion: 'batch/v1', kind: 'Job', plural: 'jobs', namespaced: true,
        columns: [
            {
                title: 'Completions',
                value: obj => readyOf(obj.status?.succeeded, obj.spec?.completions ?? 1),
                tone: obj => obj.status?.failed ? 'error' : replicasTone(obj.status?.succeeded, obj.spec?.completions ?? 1),
            },
            ageColumn,
        ],
    },
    {
        id: 'cronjobs', title: 'CronJobs', section: 'Workloads',
        apiVersion: 'batch/v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true,
        columns: [
            { title: 'Schedule', value: obj => obj.spec?.schedule ?? '' },
            { title: 'Suspend', value: obj => obj.spec?.suspend ? 'True' : 'False', tone: obj => obj.spec?.suspend ? 'warning' : null },
            { title: 'Active', value: obj => count(obj.status?.active?.length) },
            {
                title: 'Last schedule',
                value: obj => formatAge(obj.status?.lastScheduleTime),
                sortValue: obj => -timestampValue(obj.status?.lastScheduleTime),
            },
            ageColumn,
        ],
    },
    {
        id: 'services', title: 'Services', section: 'Network',
        apiVersion: 'v1', kind: 'Service', plural: 'services', namespaced: true,
        columns: [
            { title: 'Type', value: obj => obj.spec?.type ?? '' },
            { title: 'Cluster IP', value: obj => obj.spec?.clusterIP ?? '' },
            { title: 'External IP', value: serviceExternalIp },
            { title: 'Ports', value: servicePorts },
            ageColumn,
        ],
    },
    {
        id: 'ingresses', title: 'Ingresses', section: 'Network',
        apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', plural: 'ingresses', namespaced: true,
        columns: [
            { title: 'Class', value: obj => obj.spec?.ingressClassName ?? '' },
            { title: 'Hosts', value: obj => (obj.spec?.rules ?? []).map((r: any) => r.host ?? '*').join(','), wide: true },
            { title: 'Address', value: obj => (obj.status?.loadBalancer?.ingress ?? []).map((x: any) => x.ip ?? x.hostname).join(',') },
            ageColumn,
        ],
    },
    {
        id: 'configmaps', title: 'ConfigMaps', section: 'Config',
        apiVersion: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true,
        columns: [
            { title: 'Data', value: obj => count(Object.keys({ ...obj.data, ...obj.binaryData }).length) },
            ageColumn,
        ],
    },
    {
        id: 'secrets', title: 'Secrets', section: 'Config',
        apiVersion: 'v1', kind: 'Secret', plural: 'secrets', namespaced: true,
        columns: [
            { title: 'Type', value: obj => obj.type ?? '' },
            { title: 'Data', value: obj => count(Object.keys(obj.data ?? {}).length) },
            ageColumn,
        ],
    },
    {
        id: 'persistentvolumeclaims', title: 'Volume claims', section: 'Storage',
        apiVersion: 'v1', kind: 'PersistentVolumeClaim', plural: 'persistentvolumeclaims', namespaced: true,
        columns: [
            { title: 'Status', value: obj => obj.status?.phase ?? '', tone: obj => obj.status?.phase === 'Bound' ? 'ok' : 'warning' },
            { title: 'Volume', value: obj => obj.spec?.volumeName ?? '' },
            { title: 'Capacity', value: obj => obj.status?.capacity?.storage ?? '' },
            { title: 'Storage class', value: obj => obj.spec?.storageClassName ?? '' },
            ageColumn,
        ],
    },
    {
        id: 'persistentvolumes', title: 'Volumes', section: 'Storage',
        apiVersion: 'v1', kind: 'PersistentVolume', plural: 'persistentvolumes', namespaced: false,
        columns: [
            { title: 'Capacity', value: obj => obj.spec?.capacity?.storage ?? '' },
            { title: 'Status', value: obj => obj.status?.phase ?? '', tone: obj => ['Bound', 'Available'].includes(obj.status?.phase) ? 'ok' : 'warning' },
            { title: 'Claim', value: obj => obj.spec?.claimRef ? `${obj.spec.claimRef.namespace}/${obj.spec.claimRef.name}` : '' },
            { title: 'Storage class', value: obj => obj.spec?.storageClassName ?? '' },
            ageColumn,
        ],
    },
    {
        id: 'nodes', title: 'Nodes', section: 'Cluster',
        apiVersion: 'v1', kind: 'Node', plural: 'nodes', namespaced: false,
        columns: [
            { title: 'Status', value: nodeStatus, tone: obj => nodeStatus(obj) === 'Ready' ? 'ok' : 'error' },
            { title: 'Roles', value: nodeRoles },
            { title: 'Version', value: obj => obj.status?.nodeInfo?.kubeletVersion ?? '' },
            { title: 'Internal IP', value: obj => (obj.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')?.address ?? '' },
            ageColumn,
        ],
    },
    {
        id: 'namespaces', title: 'Namespaces', section: 'Cluster',
        apiVersion: 'v1', kind: 'Namespace', plural: 'namespaces', namespaced: false,
        columns: [
            { title: 'Status', value: obj => obj.status?.phase ?? '', tone: obj => obj.status?.phase === 'Active' ? null : 'warning' },
            ageColumn,
        ],
    },
    {
        id: 'events', title: 'Events', section: 'Cluster',
        apiVersion: 'v1', kind: 'Event', plural: 'events', namespaced: true,
        hideName: true,
        defaultSort: { column: 'Last seen', descending: false },
        columns: [
            { title: 'Type', value: obj => obj.type ?? '', tone: obj => obj.type === 'Warning' ? 'warning' : null },
            { title: 'Reason', value: obj => obj.reason ?? '' },
            { title: 'Object', value: obj => obj.involvedObject ? `${obj.involvedObject.kind}/${obj.involvedObject.name}` : '' },
            { title: 'Message', value: obj => obj.message ?? obj.note ?? '', wide: true },
            {
                title: 'Last seen',
                value: obj => formatAge(eventTime(obj)),
                sortValue: obj => -timestampValue(eventTime(obj)),
            },
        ],
    },
]

export function findKind (id: string): KubeResourceKind|undefined {
    return RESOURCE_KINDS.find(x => x.id === id)
}

/** Path of a collection or, with a name, of one object */
export function resourcePath (kind: KubeResourceKind, namespace: string|null, name?: string): string {
    const base = kind.apiVersion.includes('/') ? `/apis/${kind.apiVersion}` : `/api/${kind.apiVersion}`
    const ns = kind.namespaced && namespace ? `/namespaces/${encodeURIComponent(namespace)}` : ''
    return `${base}${ns}/${kind.plural}${name ? '/' + encodeURIComponent(name) : ''}`
}
