import { marker as _ } from '@biesbjerg/ngx-translate-extract-marker'
import colors from 'ansi-colors'
import { Component, Injector } from '@angular/core'
import { BaseTerminalTabComponent, ConnectableTerminalTabComponent } from 'tabby-terminal'
import { KubeTerminalProfile } from '../api'
import { loadKubeConfig } from '../kube/config'
import { KubeLogsSession, KubeShellSession } from '../sessions'

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
        return this.profile.options.mode === 'logs' ? ' LOGS ' : ' KUBE '
    }

    async initializeSession (): Promise<void> {
        await super.initializeSession()
        const options = this.profile.options

        try {
            const kc = loadKubeConfig(options)
            const session = options.mode === 'logs'
                ? new KubeLogsSession(this.logger, kc, options)
                : new KubeShellSession(this.logger, kc, options)
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
            this.write(`\r\n${colors.black.bgWhite(this.label)} ${this.profile.options.pod}/${this.profile.options.container}: session closed\r\n`)
            super.onSessionDestroyed()
        }
    }
}
