import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { KubeConfig } from '@kubernetes/client-node'
import { PortForwarder, PortForwardTarget } from '../kube/portForward'

/** Port forwards of every cluster; they outlive the tabs that started them, until stopped or Tabby closes */
@Injectable({ providedIn: 'root' })
export class PortForwardsService {
    forwards: PortForwarder[] = []
    private changed = new Subject<void>()

    get changed$ (): Observable<void> { return this.changed }

    async start (kc: KubeConfig, contextName: string, target: PortForwardTarget, localPort: number): Promise<PortForwarder> {
        const forwarder = new PortForwarder(kc, contextName, target)
        await forwarder.start(localPort)
        forwarder.changed$.subscribe(() => this.changed.next())
        this.forwards.push(forwarder)
        this.changed.next()
        return forwarder
    }

    stop (forwarder: PortForwarder): void {
        forwarder.stop()
        this.forwards = this.forwards.filter(x => x !== forwarder)
        this.changed.next()
    }
}
