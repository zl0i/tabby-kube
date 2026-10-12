import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ProfileProvider, TabRecoveryProvider } from 'tabby-core'
import TabbyTerminalModule from 'tabby-terminal'

import { KubeClusterTabComponent } from './components/kubeClusterTab.component'
import { KubeProfileSettingsComponent } from './components/kubeProfileSettings.component'
import { KubeTerminalTabComponent } from './components/kubeTerminalTab.component'
import { PortForwardModalComponent } from './components/portForwardModal.component'
import { KubeProfilesService, KubeTerminalProfilesService } from './profiles'
import { RecoveryProvider } from './recoveryProvider'

/** @hidden */
@NgModule({
    imports: [
        NgbModule,
        CommonModule,
        FormsModule,
        TabbyCoreModule,
        TabbyTerminalModule,
    ],
    providers: [
        { provide: ProfileProvider, useExisting: KubeProfilesService, multi: true },
        { provide: ProfileProvider, useExisting: KubeTerminalProfilesService, multi: true },
        { provide: TabRecoveryProvider, useClass: RecoveryProvider, multi: true },
    ],
    declarations: [
        KubeClusterTabComponent,
        KubeProfileSettingsComponent,
        KubeTerminalTabComponent,
        PortForwardModalComponent,
    ],
})
export default class KubeModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export { KubeClusterTabComponent, KubeTerminalTabComponent }
export * from './api'
