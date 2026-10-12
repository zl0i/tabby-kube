import { KubeObject } from '../api'
import { KubeResourceKind } from './resources'

/** A collection narrowed by selectors, as the list and watch APIs take them */
export interface KubeQuery {
    /** Null means all namespaces */
    namespace: string|null
    labelSelector?: string
    fieldSelector?: string
}

interface LabelSelector {
    matchLabels?: Record<string, string>
    matchExpressions?: { key: string, operator: string, values?: string[] }[]
}

/** A label selector object in the string form of ?labelSelector= */
export function labelSelectorString (selector: LabelSelector|undefined): string {
    const terms = Object.entries(selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`)
    for (const expression of selector?.matchExpressions ?? []) {
        const values = (expression.values ?? []).join(',')
        switch (expression.operator) {
            case 'In':
                terms.push(`${expression.key} in (${values})`)
                break
            case 'NotIn':
                terms.push(`${expression.key} notin (${values})`)
                break
            case 'Exists':
                terms.push(expression.key)
                break
            case 'DoesNotExist':
                terms.push(`!${expression.key}`)
                break
        }
    }
    return terms.join(',')
}

/** The pods an object runs or routes to; null for kinds without pods of their own */
export function relatedPodsQuery (kind: KubeResourceKind, obj: KubeObject): KubeQuery|null {
    const namespace = obj.metadata.namespace ?? null
    switch (kind.id) {
        case 'deployments':
        case 'statefulsets':
        case 'daemonsets':
        case 'jobs': {
            const labelSelector = labelSelectorString(obj.spec?.selector)
            return labelSelector ? { namespace, labelSelector } : null
        }
        case 'services': {
            // A service without a selector has its endpoints managed by hand
            const labelSelector = labelSelectorString({ matchLabels: obj.spec?.selector })
            return labelSelector ? { namespace, labelSelector } : null
        }
        case 'nodes':
            return { namespace: null, fieldSelector: `spec.nodeName=${obj.metadata.name}` }
        default:
            return null
    }
}

/** The events about an object, as `kubectl describe` lists them */
export function eventsQuery (kind: KubeResourceKind, obj: KubeObject): KubeQuery {
    if (obj.metadata.namespace) {
        return { namespace: obj.metadata.namespace, fieldSelector: `involvedObject.uid=${obj.metadata.uid}` }
    }
    // Events about nodes and other cluster-wide objects don't always carry their UID
    return { namespace: null, fieldSelector: `involvedObject.kind=${kind.kind},involvedObject.name=${obj.metadata.name}` }
}

/** A secret's value as text; binary values come out as they decode */
export function decodeSecretValue (value: string): string {
    return Buffer.from(value, 'base64').toString('utf-8')
}
