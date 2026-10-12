import { JSONPath } from 'jsonpath-plus'
import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { KubeApiError, kubeJson } from './http'
import { ageColumn, formatAge, KubeColumn, KubeResourceKind, Tone } from './resources'

export const CUSTOM_SECTION = 'Custom resources'

interface PrinterColumn {
    name: string
    type: string
    jsonPath: string
}

function jsonPathValues (obj: KubeObject, jsonPath: string): unknown[] {
    try {
        return JSONPath({ path: '$' + jsonPath, json: obj, wrap: true }) as unknown[]
    } catch {
        return []
    }
}

/**
 * Evaluates a printer column's path, which is JSONPath without the leading $,
 * the way kubectl prints it: lists joined with commas, objects as JSON
 */
export function evaluateColumn (obj: KubeObject, jsonPath: string): string {
    return jsonPathValues(obj, jsonPath)
        // A list holds the values, as with .spec.dnsNames
        .flatMap(x => Array.isArray(x) ? x : [x])
        .filter(x => x !== undefined && x !== null)
        .map(x => typeof x === 'object' ? JSON.stringify(x) : String(x))
        .join(',')
}

function conditionTone (value: string): Tone|null {
    if (value === 'True') {
        return 'ok'
    }
    if (value === 'False') {
        return 'error'
    }
    return value === 'Unknown' ? 'warning' : null
}

export function printerColumn (column: PrinterColumn): KubeColumn {
    if (column.type === 'date') {
        return {
            title: column.name,
            value: obj => formatAge(evaluateColumn(obj, column.jsonPath) || undefined),
            sortValue: obj => -(Date.parse(evaluateColumn(obj, column.jsonPath)) || 0),
        }
    }
    const numeric = column.type === 'integer' || column.type === 'number'
    return {
        title: column.name,
        value: obj => evaluateColumn(obj, column.jsonPath),
        sortValue: numeric ? obj => Number(evaluateColumn(obj, column.jsonPath)) || 0 : undefined,
        // Readiness columns such as cert-manager's "Ready" hold condition statuses
        tone: column.type === 'string' ? obj => conditionTone(evaluateColumn(obj, column.jsonPath)) : undefined,
    }
}

/** A custom resource definition as a kind the browser can list */
export function customKind (crd: KubeObject): KubeResourceKind|null {
    const versions: any[] = crd.spec?.versions ?? []
    const version = versions.find(x => x.storage && x.served) ?? versions.find(x => x.served)
    if (!version) {
        return null
    }
    const columns: KubeColumn[] = (version.additionalPrinterColumns ?? []).map(printerColumn)
    if (!columns.some(x => x.title === 'Age')) {
        columns.push(ageColumn)
    }
    return {
        id: `${crd.spec.names.plural}.${crd.spec.group}`,
        title: crd.spec.names.kind,
        section: CUSTOM_SECTION,
        group: crd.spec.group,
        apiVersion: `${crd.spec.group}/${version.name}`,
        kind: crd.spec.names.kind,
        plural: crd.spec.names.plural,
        namespaced: crd.spec.scope === 'Namespaced',
        columns,
    }
}

/** Kinds of the cluster's custom resources; none when the credentials may not list them */
export async function listCustomKinds (kc: KubeConfig): Promise<KubeResourceKind[]> {
    try {
        const list = await kubeJson<{ items: KubeObject[] }>(kc, 'GET', '/apis/apiextensions.k8s.io/v1/customresourcedefinitions')
        return list.items
            .map(customKind)
            .filter((x): x is KubeResourceKind => !!x)
            .sort((a, b) => a.group!.localeCompare(b.group!) || a.title.localeCompare(b.title))
    } catch (e) {
        if (e instanceof KubeApiError && (e.statusCode === 403 || e.statusCode === 404)) {
            return []
        }
        throw e
    }
}
