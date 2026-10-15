import { KubeObject } from '../api'
import { HelmRelease } from './helm'
import { decodeSecretValue } from './related'
import { formatAge, KubeResourceKind, Tone } from './resources'

/** What `kubectl describe` puts first, per kind: [label, value] */
export function describeProperties (kind: KubeResourceKind, obj: KubeObject): [string, string][] {
    const properties: [string, string|undefined][] = []
    const owners = (obj.metadata as any).ownerReferences as { kind: string, name: string }[]|undefined
    switch (kind.id) {
        case 'pods':
            properties.push(
                ['Node', obj.spec?.nodeName],
                ['Pod IP', obj.status?.podIP],
                ['QoS class', obj.status?.qosClass],
                ['Service account', obj.spec?.serviceAccountName],
            )
            break
        case 'deployments':
        case 'statefulsets':
            properties.push(
                ['Replicas', `${obj.status?.readyReplicas ?? 0} ready of ${obj.spec?.replicas ?? 0}`],
                ['Strategy', obj.spec?.strategy?.type ?? obj.spec?.updateStrategy?.type],
            )
            break
        case 'daemonsets':
            properties.push(['Pods', `${obj.status?.numberReady ?? 0} ready of ${obj.status?.desiredNumberScheduled ?? 0}`])
            break
        case 'services':
            properties.push(
                ['Type', obj.spec?.type],
                ['Cluster IP', obj.spec?.clusterIP],
                ['Ports', (obj.spec?.ports ?? []).map((p: any) => `${p.name ? p.name + ' ' : ''}${p.port}→${p.targetPort ?? p.port}/${p.protocol ?? 'TCP'}`).join(', ')],
            )
            break
        case 'ingresses':
            properties.push(['Rules', (obj.spec?.rules ?? []).flatMap((r: any) => (r.http?.paths ?? []).map((p: any) =>
                `${r.host ?? '*'}${p.path ?? '/'} → ${p.backend?.service?.name ?? ''}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ''}`,
            )).join('\n')])
            break
        case 'nodes':
            properties.push(
                ['Kubelet', obj.status?.nodeInfo?.kubeletVersion],
                ['OS', obj.status?.nodeInfo?.osImage],
                ['Container runtime', obj.status?.nodeInfo?.containerRuntimeVersion],
                ['CPU', `${obj.status?.allocatable?.cpu ?? '?'} allocatable of ${obj.status?.capacity?.cpu ?? '?'}`],
                ['Memory', `${obj.status?.allocatable?.memory ?? '?'} allocatable of ${obj.status?.capacity?.memory ?? '?'}`],
            )
            break
    }
    if (owners?.length) {
        properties.push(['Controlled by', owners.map(x => `${x.kind}/${x.name}`).join(', ')])
    }
    if (obj.metadata.creationTimestamp) {
        properties.push(['Created', `${formatAge(obj.metadata.creationTimestamp)} ago (${new Date(obj.metadata.creationTimestamp).toLocaleString()})`])
    }
    return properties.filter((x): x is [string, string] => !!x[1])
}

export interface ContainerInfo {
    name: string
    image: string
    init: boolean
    state: string
    tone: Tone|null
    restarts: number
    ports: string
}

/** Containers of a pod with their states, init containers first as they run first */
export function describeContainers (pod: KubeObject): ContainerInfo[] {
    const describe = (spec: any, statuses: any[], init: boolean): ContainerInfo => {
        const status = statuses.find(x => x.name === spec.name)
        const state = status?.state ?? {}
        let text = 'Waiting'
        let tone: Tone|null = 'warning'
        if (state.running) {
            text = status.ready ? 'Running' : 'Running, not ready'
            tone = status.ready ? 'ok' : 'warning'
        } else if (state.terminated) {
            text = `${state.terminated.reason ?? 'Terminated'} (exit code ${state.terminated.exitCode})`
            tone = state.terminated.exitCode === 0 ? 'muted' : 'error'
        } else if (state.waiting?.reason) {
            text = state.waiting.reason
            tone = ['ContainerCreating', 'PodInitializing'].includes(state.waiting.reason) ? 'warning' : 'error'
        }
        return {
            name: spec.name,
            image: spec.image,
            init,
            state: text,
            tone,
            restarts: status?.restartCount ?? 0,
            ports: (spec.ports ?? []).map((p: any) => `${p.containerPort}/${p.protocol ?? 'TCP'}`).join(', '),
        }
    }
    return [
        ...(pod.spec?.initContainers ?? []).map((c: any) => describe(c, pod.status?.initContainerStatuses ?? [], true)),
        ...(pod.spec?.containers ?? []).map((c: any) => describe(c, pod.status?.containerStatuses ?? [], false)),
    ]
}

export interface ConditionInfo {
    type: string
    status: string
    tone: Tone|null
    reason: string
    message: string
    age: string
}

/** Conditions whose "True" is bad news, as node pressure */
const NEGATIVE_CONDITIONS = ['MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable', 'ReplicaFailure', 'Failed']

export function describeConditions (obj: KubeObject): ConditionInfo[] {
    return (obj.status?.conditions ?? []).map((c: any) => {
        const good = NEGATIVE_CONDITIONS.includes(c.type) ? c.status === 'False' : c.status === 'True'
        return {
            type: c.type,
            status: c.status,
            tone: c.status === 'Unknown' ? 'warning' : good ? 'ok' : 'error',
            reason: c.reason ?? '',
            message: c.message ?? '',
            age: formatAge(c.lastTransitionTime ?? c.lastUpdateTime),
        }
    })
}

export interface DataEntry {
    key: string
    value: string
    secret: boolean
}

/** Values of a config map, or of a secret decoded */
export function describeData (kind: KubeResourceKind, obj: KubeObject): DataEntry[] {
    if (kind.id === 'secrets') {
        return Object.entries(obj.data ?? {}).map(([key, value]) => ({ key, value: decodeSecretValue(String(value)), secret: true }))
    }
    if (kind.id === 'configmaps') {
        return [
            ...Object.entries(obj.data ?? {}).map(([key, value]) => ({ key, value: String(value), secret: false })),
            ...Object.keys(obj.binaryData ?? {}).map(key => ({ key, value: '(binary)', secret: false })),
        ]
    }
    return []
}

/** What `helm status` tells */
export function describeRelease (release: HelmRelease): [string, string][] {
    const when = (timestamp: string|undefined) => timestamp ? `${formatAge(timestamp)} ago (${new Date(timestamp).toLocaleString()})` : undefined
    const properties: [string, string|undefined][] = [
        ['Chart', `${release.chart.metadata.name} ${release.chart.metadata.version}`],
        ['App version', release.chart.metadata.appVersion],
        ['Status', release.info.status],
        ['Revision', String(release.version)],
        ['Updated', when(release.info.last_deployed)],
        ['Installed', when(release.info.first_deployed)],
        ['Description', release.info.description],
    ]
    return properties.filter((x): x is [string, string] => !!x[1])
}
