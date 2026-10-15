import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector } from '@angular/core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { KubeTerminalProfile } from '../api'
import { loadKubeConfig } from '../kube/config'
import { KubeLogsSession, KubeNodeShellSession, KubeShellSession, KubeWorkloadLogsSession } from '../sessions'

/** @hidden */
@Component({
    selector: 'kube-terminal-tab',
    template: BaseTerminalTabComponent.template,
    styles: BaseTerminalTabComponent.styles,
    animations: BaseTerminalTabComponent.animations,
})
export class KubeTerminalTabComponent extends ConnectableTerminalTabComponent<KubeTerminalProfile> {
    session: KubeShellSession|KubeLogsSession|null = null

    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor (injector: Injector) {
        super(injector)
    }

    private get label (): string {
        switch (this.profile.options.mode) {
            case 'logs':
            case 'workload-logs':
                return ' LOGS '
            case 'node-shell':
                return ' NODE '
            default:
                return ' KUBE '
        }
    }

    /** What the session was attached to, for the notice when it ends */
    private get target (): string {
        const options = this.profile.options
        switch (options.mode) {
            case 'workload-logs':
                return `${options.workloadKind}/${options.workloadName}`
            case 'node-shell':
                return `node ${options.node}`
            default:
                return `${options.pod}/${options.container}`
        }
    }

    private createSession (): KubeShellSession|KubeLogsSession {
        const options = this.profile.options
        const kc = loadKubeConfig(options)
        switch (options.mode) {
            case 'logs':
                return new KubeLogsSession(this.logger, kc, options)
            case 'workload-logs':
                return new KubeWorkloadLogsSession(this.logger, kc, options)
            case 'node-shell':
                return new KubeNodeShellSession(this.logger, kc, options)
            default:
                return new KubeShellSession(this.logger, kc, options)
        }
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        try {
            const session = this.createSession()
            this.setSession(session)
            this.attachSessionHandler(session.message$, message => {
                this.write(`\r\n${colors.black.bgWhite(this.label)} ${message}\r\n`)
            })

            this.startSpinner(this.translate.instant(_('Connecting')))
            try {
                await session.start(this.size)
            } finally {
                this.stopSpinner()
            }
        } catch (e) {
            this.write(colors.black.bgRed(' X ') + ' ' + colors.red(e.message) + '\r\n')
            this.offerReconnection()
        }
    }

    protected onSessionDestroyed (): void {
        if (this.frontend) {
            this.write(`\r\n${colors.black.bgWhite(this.label)} ${this.target}: session closed\r\n`)
            super.onSessionDestroyed()
        }
    }
}
