import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, ProfileProvider, TranslateService } from 'tabby-core'
import { KubeContainerMode, KubeProfile, KubeTarget, KubeTerminalProfile } from './api'
import { KubeClusterTabComponent } from './components/kubeClusterTab.component'
import { KubeProfileSettingsComponent } from './components/kubeProfileSettings.component'
import { KubeTerminalTabComponent } from './components/kubeTerminalTab.component'
import { listContexts } from './kube/config'
import { DEFAULT_NODE_SHELL_IMAGE, DEFAULT_NODE_SHELL_NAMESPACE } from './kube/nodeShell'
import { KubeResourceKind } from './kube/resources'

export const CLUSTER_ICON = 'fas fa-dharmachakra'

/** Clusters: one profile per context of the default kubeconfig, plus user-made ones for other files */
@Injectable({ providedIn: 'root' })
export class KubeProfilesService extends ProfileProvider<KubeProfile> {
    id = 'kube'
    name = _('Kubernetes')
    settingsComponent = KubeProfileSettingsComponent
    configDefaults = {
        options: {
            kubeconfig: '',
            context: '',
            namespace: '',
            nodeShellImage: DEFAULT_NODE_SHELL_IMAGE,
            nodeShellNamespace: DEFAULT_NODE_SHELL_NAMESPACE,
        },
    }

    constructor (private translate: TranslateService) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<KubeProfile>[]> {
        return [
            {
                id: 'kube:template',
                type: 'kube',
                name: this.translate.instant('Kubernetes cluster'),
                icon: CLUSTER_ICON,
                isBuiltin: true,
                isTemplate: true,
            },
            ...listContexts('').map(context => ({
                id: `kube:context:${context}`,
                type: 'kube',
                name: context,
                icon: CLUSTER_ICON,
                options: { context },
                isBuiltin: true,
            })),
        ]
    }

    async getNewTabParameters (profile: KubeProfile): Promise<NewTabParameters<KubeClusterTabComponent>> {
        return {
            type: KubeClusterTabComponent,
            inputs: { profile },
        }
    }

    getSuggestedName (profile: PartialProfile<KubeProfile>): string {
        return this.getDescription(profile)
    }

    getDescription (profile: PartialProfile<KubeProfile>): string {
        const context = profile.options?.context ? profile.options.context : this.translate.instant('current context')
        return profile.options?.namespace ? `${context} / ${profile.options.namespace}` : context
    }
}

/** Shells and logs of containers; these profiles are made by the cluster tab rather than saved */
@Injectable({ providedIn: 'root' })
export class KubeTerminalProfilesService extends ProfileProvider<KubeTerminalProfile> {
    id = 'kube-terminal'
    name = _('Kubernetes container')
    configDefaults = {
        options: {
            kubeconfig: '',
            context: '',
            mode: 'shell',
            namespace: '',
            pod: '',
            container: '',
            command: '',
            tailLines: 500,
            previous: false,
            workloadKind: '',
            workloadName: '',
            node: '',
            image: DEFAULT_NODE_SHELL_IMAGE,
        },
        clearServiceMessagesOnConnect: false,
    }

    async getBuiltinProfiles (): Promise<PartialProfile<KubeTerminalProfile>[]> {
        return []
    }

    async getNewTabParameters (profile: KubeTerminalProfile): Promise<NewTabParameters<KubeTerminalTabComponent>> {
        return {
            type: KubeTerminalTabComponent,
            inputs: { profile },
        }
    }

    getDescription (profile: PartialProfile<KubeTerminalProfile>): string {
        const options = profile.options
        switch (options?.mode) {
            case 'workload-logs':
                return `${options.namespace}/${options.workloadName}`
            case 'node-shell':
                return `node ${options.node}`
            default:
                return `${options?.namespace}/${options?.pod}/${options?.container}`
        }
    }
}

export function containerProfile (
    target: KubeTarget,
    namespace: string,
    pod: string,
    container: string,
    mode: KubeContainerMode,
    extra: { previous?: boolean } = {},
): PartialProfile<KubeTerminalProfile> {
    return {
        type: 'kube-terminal',
        name: `${mode === 'logs' ? 'logs: ' : ''}${pod}/${container}`,
        icon: mode === 'logs' ? 'fas fa-stream' : 'fas fa-terminal',
        options: { ...target, namespace, pod, container, mode, ...extra },
    }
}

/** The logs of all the pods of a workload or service, in one tab */
export function workloadLogsProfile (target: KubeTarget, kind: KubeResourceKind, namespace: string, name: string): PartialProfile<KubeTerminalProfile> {
    return {
        type: 'kube-terminal',
        name: `logs: ${kind.kind.toLowerCase()}/${name}`,
        icon: 'fas fa-stream',
        // Fewer lines per container than for one, as there are many
        options: { ...target, mode: 'workload-logs', namespace, workloadKind: kind.id, workloadName: name, tailLines: 100 },
    }
}

export function nodeShellProfile (target: KubeTarget, node: string, image: string, namespace: string): PartialProfile<KubeTerminalProfile> {
    return {
        type: 'kube-terminal',
        name: `node: ${node}`,
        icon: 'fas fa-server',
        options: { ...target, mode: 'node-shell', node, image, namespace },
    }
}
