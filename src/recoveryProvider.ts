import { Injectable, Injector } from '@angular/core'
import { BaseTabComponent, NewTabParameters, ProfilesService, RecoveryToken, TabRecoveryProvider } from 'tabby-core'

import { KubeClusterTabComponent } from './components/kubeClusterTab.component'
import { KubeTerminalTabComponent } from './components/kubeTerminalTab.component'

/** @hidden */
@Injectable()
export class RecoveryProvider extends TabRecoveryProvider<BaseTabComponent> {
    constructor (private injector: Injector) { super() }

    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === 'app:kube-tab' || recoveryToken.type === 'app:kube-terminal-tab'
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<BaseTabComponent>> {
        const profile = this.injector.get(ProfilesService).getConfigProxyForProfile(recoveryToken.profile)
        if (recoveryToken.type === 'app:kube-terminal-tab') {
            return {
                type: KubeTerminalTabComponent,
                inputs: { profile, savedState: recoveryToken.savedState },
            }
        }
        return {
            type: KubeClusterTabComponent,
            inputs: { profile, state: recoveryToken.state },
        }
    }
}
