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
}

export type KubeTerminalMode = 'shell' | 'logs'

/** A shell in a container or its logs, opened in a terminal tab */
export interface KubeTerminalProfile extends ConnectableTerminalProfile {
    options: KubeTerminalProfileOptions
}

export interface KubeTerminalProfileOptions extends KubeTarget {
    mode: KubeTerminalMode
    namespace: string
    pod: string
    container: string
    /** Shell mode: the command to run. Empty means bash where the container has it, sh otherwise */
    command: string
    /** Logs mode: how many of the last lines to show before following */
    tailLines: number
    /** Logs mode: logs of the previous, terminated instance of the container */
    previous: boolean
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
