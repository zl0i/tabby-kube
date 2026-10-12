/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component } from '@angular/core'
import { Observable, map } from 'rxjs'
import { ProfileSettingsComponent } from 'tabby-core'
import { KubeProfile } from '../api'
import { listContexts } from '../kube/config'

/** @hidden */
@Component({
    templateUrl: './kubeProfileSettings.component.pug',
})
export class KubeProfileSettingsComponent implements ProfileSettingsComponent<KubeProfile> {
    profile: KubeProfile
    contexts: string[] = []

    contextsAutocomplete = (text$: Observable<string>) => text$.pipe(map(query =>
        this.contexts.filter(x => !query || x.toLowerCase().includes(query.toLowerCase())),
    ))

    ngOnInit () {
        this.loadContexts()
    }

    loadContexts () {
        this.contexts = listContexts(this.profile.options.kubeconfig)
    }
}
