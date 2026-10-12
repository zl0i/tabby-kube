import { Injectable } from '@angular/core'
import { Command, CommandContext, CommandProvider } from 'tabby-core'
import { KubeClusterTabComponent } from './components/kubeClusterTab.component'

/** Navigation of the focused cluster tab, in Tabby's command palette */
@Injectable()
export class KubeCommandProvider extends CommandProvider {
    async provide (context: CommandContext): Promise<Command[]> {
        const tab = context.tab
        if (!(tab instanceof KubeClusterTabComponent) || !tab.cluster) {
            return []
        }
        return [
            {
                id: 'kube:show-resources',
                label: 'Kubernetes: show resources…',
                run: async () => tab.pickKind(),
            },
            {
                id: 'kube:switch-namespace',
                label: 'Kubernetes: switch namespace…',
                run: async () => tab.pickNamespace(),
            },
        ]
    }
}
