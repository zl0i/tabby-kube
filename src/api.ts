import { ConnectableTerminalProfile } from 'tabby-terminal'
import { Profile } from 'tabby-core'

/** Where a profile finds its cluster: a kubeconfig file and a context in it */
export interface KubeTarget {
    /** Path to a kubeconfig file. Empty means $KUBECONFIG (all of its files), then ~/.kube/config */
    kubeconfig: string
    /** Empty means the kubeconfig's current-context */
    context: string
}

/** A cluster, opened in a cluster browser tab */
export interface KubeProfile extends Profile {
    options: KubeProfileOptions
}

export interface KubeProfileOptions extends KubeTarget {
    /** Namespace to open; empty means all namespaces */
    namespace: string
    /** Node shells: the image of the pod that enters the node, which needs nsenter */
    nodeShellImage: string
    /** Node shells: the namespace their pods run in, which has to allow privileged pods */
    nodeShellNamespace: string
}

/** Of one container: a shell, or its logs */
export type KubeContainerMode = 'shell' | 'logs'

/**
 * - `shell`, `logs`: of one container
 * - `workload-logs`: of every container of the pods a workload or service selects, as they come and go
 * - `node-shell`: a shell on a node, through a privileged pod deleted when the shell ends
 */
export type KubeTerminalMode = KubeContainerMode | 'workload-logs' | 'node-shell'

/** A shell or logs, opened in a terminal tab */
export interface KubeTerminalProfile extends ConnectableTerminalProfile {
    options: KubeTerminalProfileOptions
}

export interface KubeTerminalProfileOptions extends KubeTarget {
    mode: KubeTerminalMode
    /** The pod's namespace; for node shells, where their pods run */
    namespace: string
    pod: string
    container: string
    /** Shell mode: the command to run. Empty means bash where the container has it, sh otherwise */
    command: string
    /** Logs modes: how many of the last lines to show before following, per container */
    tailLines: number
    /** Logs mode: logs of the previous, terminated instance of the container */
    previous: boolean
    /** Workload logs: the kind (its id) and the name of the object whose pods log */
    workloadKind: string
    workloadName: string
    /** Node shell: the node, and the image of the pod that enters it */
    node: string
    image: string
}

/** The fields every Kubernetes object has, as far as the browser cares */
export interface KubeObject {
    apiVersion?: string
    kind?: string
    metadata: {
        name: string
        namespace?: string
        uid: string
        creationTimestamp?: string
        deletionTimestamp?: string
        resourceVersion?: string
        labels?: Record<string, string>
        annotations?: Record<string, string>
    }
    spec?: any
    status?: any
    [key: string]: any
}
