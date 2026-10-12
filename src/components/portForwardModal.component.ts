import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { ForwardablePort } from '../kube/portForward'

export interface PortForwardChoice {
    remotePort: number
    /** 0 picks a free port */
    localPort: number
}

function isPort (value: string): boolean {
    const port = Number(value.trim())
    return /^\d+$/.test(value.trim()) && port >= 1 && port <= 65535
}

/** @hidden */
@Component({
    templateUrl: './portForwardModal.component.pug',
})
export class PortForwardModalComponent {
    @Input() title: string
    @Input() ports: ForwardablePort[] = []
    remotePort = ''
    localPort = ''

    constructor (private modalInstance: NgbActiveModal) { }

    ngOnInit (): void {
        this.remotePort = this.ports.length ? String(this.ports[0].port) : ''
    }

    get remotePortValid (): boolean {
        return isPort(this.remotePort)
    }

    get localPortValid (): boolean {
        return !this.localPort.trim() || this.localPort.trim() === '0' || isPort(this.localPort)
    }

    isPicked (port: ForwardablePort): boolean {
        return this.remotePort.trim() === String(port.port)
    }

    pick (port: ForwardablePort): void {
        this.remotePort = String(port.port)
    }

    ok (): void {
        if (!this.remotePortValid || !this.localPortValid) {
            return
        }
        const remotePort = Number(this.remotePort)
        this.modalInstance.close({
            remotePort,
            // The same port locally unless said otherwise, as kubectl does
            localPort: this.localPort.trim() ? Number(this.localPort) : remotePort,
        } as PortForwardChoice)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }
}
