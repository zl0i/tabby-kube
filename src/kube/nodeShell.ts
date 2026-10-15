import { KubeConfig } from '@kubernetes/client-node'
import { KubeObject } from '../api'
import { KubeApiError, kubeJson } from './http'

export const DEFAULT_NODE_SHELL_IMAGE = 'alpine:3.20'
export const DEFAULT_NODE_SHELL_NAMESPACE = 'kube-system'
export const NODE_SHELL_CONTAINER = 'shell'
/** The pod outlives a shell left open this long at most */
const POD_LIFETIME_SECONDS = 24 * 3600
const START_TIMEOUT = 120000
const POLL_INTERVAL = 1000

/** Enters the node's namespaces from the privileged pod: its own login shell, as on the node */
export const NODE_SHELL_COMMAND = [
    'nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    'sh', '-c', '[ -z "$TERM" ] && export TERM=xterm-256color; command -v bash >/dev/null 2>&1 && exec bash -l || exec sh -l',
]

/**
 * A pod with the node's process, network and IPC namespaces, privileged, so that nsenter gets
 * into PID 1's namespaces - a shell as if on the node, as Lens and `kubectl debug node` do it
 */
export function nodeShellPod (node: string, image: string): Record<string, any> {
    return {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
            generateName: `node-shell-${node.toLowerCase().replace(/[^a-z0-9.-]/g, '-').slice(0, 40)}-`,
            labels: {
                'app.kubernetes.io/managed-by': 'tabby-kube',
                'app.kubernetes.io/component': 'node-shell',
            },
        },
        spec: {
            nodeName: node,
            hostPID: true,
            hostIPC: true,
            hostNetwork: true,
            restartPolicy: 'Never',
            terminationGracePeriodSeconds: 0,
            // Nodes that take no pods (control planes, cordoned or tainted ones) too
            tolerations: [{ operator: 'Exists' }],
            containers: [{
                name: NODE_SHELL_CONTAINER,
                image,
                command: ['sleep', String(POD_LIFETIME_SECONDS)],
                securityContext: { privileged: true },
            }],
        },
    }
}

/** Why a pod is not going to run, if it isn't */
export function podStartProblem (pod: KubeObject): string|null {
    if (['Failed', 'Succeeded'].includes(pod.status?.phase)) {
        return `The pod has stopped (${pod.status.reason ?? pod.status.phase})${pod.status.message ? ': ' + pod.status.message : ''}`
    }
    for (const status of pod.status?.containerStatuses ?? []) {
        const waiting = status.state?.waiting
        if (waiting && ['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerError', 'CreateContainerConfigError', 'CrashLoopBackOff'].includes(waiting.reason)) {
            return `${waiting.reason}${waiting.message ? ': ' + waiting.message : ''}`
        }
        if (status.state?.terminated) {
            return `The container has stopped: ${status.state.terminated.reason ?? 'exit code ' + status.state.terminated.exitCode}`
        }
    }
    // Admission or scheduling refusals show up as conditions
    const unschedulable = (pod.status?.conditions ?? []).find((c: any) => c.type === 'PodScheduled' && c.status === 'False' && c.reason === 'Unschedulable')
    return unschedulable ? `The pod can't be scheduled: ${unschedulable.message}` : null
}

export function isRunning (pod: KubeObject): boolean {
    return pod.status?.phase === 'Running' && (pod.status.containerStatuses ?? []).every((x: any) => x.state?.running)
}

/** What the pod is waiting for now, as "ContainerCreating" */
export function podProgress (pod: KubeObject): string {
    const waiting = (pod.status?.containerStatuses ?? []).find((x: any) => x.state?.waiting)?.state.waiting.reason
    return waiting ?? pod.status?.phase ?? 'Pending'
}

function podPath (namespace: string, name?: string): string {
    return `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods${name ? '/' + encodeURIComponent(name) : ''}`
}

export async function createNodeShellPod (kc: KubeConfig, namespace: string, node: string, image: string): Promise<KubeObject> {
    return kubeJson(kc, 'POST', podPath(namespace), { body: nodeShellPod(node, image) })
}

/** Waits until the pod runs, telling what it is waiting for as that changes */
export async function waitForPod (kc: KubeConfig, namespace: string, name: string, onProgress: (progress: string) => void, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT
    let lastProgress = ''
    while (!signal.aborted) {
        const pod = await kubeJson<KubeObject>(kc, 'GET', podPath(namespace, name), { signal })
        if (isRunning(pod)) {
            return
        }
        const problem = podStartProblem(pod)
        if (problem) {
            throw new Error(problem)
        }
        const progress = podProgress(pod)
        if (progress !== lastProgress) {
            lastProgress = progress
            onProgress(progress)
        }
        if (Date.now() > deadline) {
            throw new Error(`The pod did not start in ${START_TIMEOUT / 1000} s (${progress})`)
        }
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))
    }
    throw new Error('Cancelled')
}

export async function deletePod (kc: KubeConfig, namespace: string, name: string): Promise<void> {
    try {
        await kubeJson(kc, 'DELETE', podPath(namespace, name), { body: { gracePeriodSeconds: 0 } })
    } catch (e) {
        if (!(e instanceof KubeApiError && e.statusCode === 404)) {
            throw e
        }
    }
}
