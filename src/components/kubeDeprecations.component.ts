import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core'
import { PlatformService } from 'tabby-core'
import { ApiScan, scanApiUsage } from '../kube/apiScan'
import { KubeCluster } from '../kube/cluster'
import { ApiCheckContext, ApiFinding, ApiStatus, checkUsage, formatVersion, KubeVersion } from '../kube/deprecations'
import { Tone } from '../kube/resources'

/** How many minor versions ahead an upgrade can be checked for */
const UPGRADES_AHEAD = 4

const STATUS_ORDER: ApiStatus[] = ['removed', 'removed-in-target', 'deprecated']

export interface ApiFindingLink {
    kindId: string
    uid: string
    namespace?: string
}

/**
 * Old API versions in use: in Helm releases' stored manifests, in what kubectl applied,
 * and in requests the API server has had - for this version of Kubernetes or one to upgrade to
 * @hidden
 */
@Component({
    selector: 'kube-deprecations',
    templateUrl: './kubeDeprecations.component.pug',
    styleUrls: ['./kubeDeprecations.component.scss'],
})
export class KubeDeprecationsComponent implements OnInit {
    @Input() cluster: KubeCluster
    @Input() context: ApiCheckContext
    @Output() open = new EventEmitter<ApiFindingLink>()

    scanning = false
    error: string|null = null
    scan: ApiScan|null = null
    targets: KubeVersion[] = []
    targetIndex = 0
    findings: ApiFinding[] = []

    constructor (private platform: PlatformService) { }

    openMapKubeApis (): void {
        this.platform.openExternal('https://github.com/helm/helm-mapkubeapis')
    }

    async ngOnInit (): Promise<void> {
        const { major, minor } = this.context.version
        this.targets = Array.from({ length: UPGRADES_AHEAD + 1 }, (_, i) => ({ major, minor: minor + i }))
        await this.rescan()
    }

    get target (): KubeVersion {
        return this.targets[this.targetIndex]
    }

    async rescan (): Promise<void> {
        this.scanning = true
        this.error = null
        try {
            this.scan = await scanApiUsage(this.cluster.kc)
            this.update()
        } catch (e) {
            this.error = e.message
        } finally {
            this.scanning = false
        }
    }

    setTarget (index: number): void {
        this.targetIndex = index
        this.update()
    }

    private update (): void {
        this.findings = (this.scan?.usages ?? [])
            .map(x => checkUsage(x, this.context, this.target))
            .filter((x): x is ApiFinding => !!x)
            .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
                || a.apiVersion.localeCompare(b.apiVersion)
                || a.kind.localeCompare(b.kind)
                || a.name.localeCompare(b.name))
    }

    count (status: ApiStatus): number {
        return this.findings.filter(x => x.status === status).length
    }

    /** Stored Helm manifests with removed APIs break `helm upgrade` until migrated */
    get helmBlocked (): boolean {
        return this.findings.some(x => x.source === 'helm' && x.status === 'removed')
    }

    // Template helpers

    formatVersion (version: KubeVersion): string {
        return formatVersion(version)
    }

    targetLabel (version: KubeVersion, index: number): string {
        return index ? `an upgrade to ${formatVersion(version)}` : `this version (${formatVersion(version)})`
    }

    statusLabel (finding: ApiFinding): string {
        switch (finding.status) {
            case 'removed':
                return 'Removed'
            case 'removed-in-target':
                return `Gone in ${formatVersion(this.target)}`
            default:
                return 'Deprecated'
        }
    }

    statusTone (finding: ApiFinding): Tone {
        return finding.status === 'deprecated' ? 'warning' : 'error'
    }

    objectLabel (finding: ApiFinding): string {
        if (finding.source === 'requested') {
            return finding.kind
        }
        return `${finding.kind} ${finding.namespace ? finding.namespace + '/' : ''}${finding.name}`
    }

    sourceLabel (finding: ApiFinding): string {
        switch (finding.source) {
            case 'helm':
                return `Helm release ${finding.release!.namespace}/${finding.release!.name} (revision ${finding.release!.revision})`
            case 'applied':
                return 'Last kubectl apply'
            default:
                return 'Requested from the API server'
        }
    }

    select (finding: ApiFinding): void {
        if (finding.link) {
            this.open.emit(finding.link)
        }
    }
}
