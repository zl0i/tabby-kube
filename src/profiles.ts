import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, ProfileProvider, TranslateService } from 'tabby-core'
import { KubeProfile, KubeTarget, KubeTerminalMode, KubeTerminalProfile } from './api'
import { KubeClusterTabComponent } from './components/kubeClusterTab.component'
import { KubeProfileSettingsComponent } from './components/kubeProfileSettings.component'
import { KubeTerminalTabComponent } from './components/kubeTerminalTab.component'
import { listContexts } from './kube/config'

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
        return `${profile.options?.namespace}/${profile.options?.pod}/${profile.options?.container}`
    }
}

export function containerProfile (
    target: KubeTarget,
    namespace: string,
    pod: string,
    container: string,
    mode: KubeTerminalMode,
    extra: { previous?: boolean } = {},
): PartialProfile<KubeTerminalProfile> {
    return {
        type: 'kube-terminal',
        name: `${mode === 'logs' ? 'logs: ' : ''}${pod}/${container}`,
        icon: mode === 'logs' ? 'fas fa-stream' : 'fas fa-terminal',
        options: { ...target, namespace, pod, container, mode, ...extra },
    }
}
