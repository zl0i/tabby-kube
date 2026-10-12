import { Component, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output } from '@angular/core'
import { auditTime } from 'rxjs'
import { PlatformService } from 'tabby-core'
import { KubeObject, KubeTerminalMode } from '../api'
import { KubeCluster, toYaml } from '../kube/cluster'
import {
    ConditionInfo,
    ContainerInfo,
    DataEntry,
    describeConditions,
    describeContainers,
    describeData,
    describeProperties,
} from '../kube/describe'
import { canForward } from '../kube/portForward'
import { eventsQuery, relatedPodsQuery } from '../kube/related'
import { findKind, formatAge, KubeResourceKind, podContainers, podReady, podRestarts, podStatus, podTone, Tone } from '../kube/resources'
import { ResourceWatcher } from '../kube/watcher'

const UPDATE_INTERVAL = 250

export interface ContainerRequest {
    pod: KubeObject
    container: string
    mode: KubeTerminalMode
    previous: boolean
}

export type DetailsAction = 'edit' | 'forward' | 'restart' | 'scale' | 'delete'

function eventTime (event: KubeObject): string|undefined {
    return event.lastTimestamp ?? event.eventTime ?? event.metadata.creationTimestamp
}

/**
 * The selected object: what `kubectl describe` tells - properties, containers, conditions,
 * data, the pods it runs and the events about it, kept live - and its YAML
 * @hidden
 */
@Component({
    selector: 'kube-details',
    templateUrl: './kubeDetails.component.pug',
    styleUrls: ['./kubeDetails.component.scss'],
})
export class KubeDetailsComponent implements OnChanges, OnDestroy {
    @Input() cluster: KubeCluster
    @Input() kind: KubeResourceKind
    @Input() obj: KubeObject
    @Output() container = new EventEmitter<ContainerRequest>()
    @Output() goToPod = new EventEmitter<KubeObject>()
    @Output() action = new EventEmitter<DetailsAction>()
    @Output() closed = new EventEmitter<void>()

    tab: 'overview' | 'yaml' = 'overview'
    yaml = ''
    properties: [string, string][] = []
    labels: [string, string][] = []
    annotations: [string, string][] = []
    containers: ContainerInfo[] = []
    conditions: ConditionInfo[] = []
    data: DataEntry[] = []
    showAnnotations = false
    revealed = new Set<string>()
    events: KubeObject[] = []
    /** Null for kinds that run no pods */
    pods: KubeObject[]|null = null
    private eventsWatcher: ResourceWatcher|null = null
    private podsWatcher: ResourceWatcher|null = null
    private watchedUid: string|null = null

    constructor (
        private zone: NgZone,
        private platform: PlatformService,
    ) { }

    ngOnChanges (): void {
        if (this.obj.metadata.uid !== this.watchedUid) {
            this.watchedUid = this.obj.metadata.uid
            this.revealed.clear()
            this.showAnnotations = false
            this.watchRelated()
        }
        this.yaml = toYaml(this.kind, this.obj)
        this.properties = describeProperties(this.kind, this.obj)
        this.labels = Object.entries(this.obj.metadata.labels ?? {})
        this.annotations = Object.entries(this.obj.metadata.annotations ?? {})
        this.containers = this.kind.id === 'pods' ? describeContainers(this.obj) : []
        this.conditions = describeConditions(this.obj)
        this.data = describeData(this.kind, this.obj)
    }

    ngOnDestroy (): void {
        this.stopWatching()
    }

    get isPod (): boolean {
        return this.kind.id === 'pods'
    }

    get canForward (): boolean {
        return canForward(this.kind)
    }

    private watchRelated (): void {
        this.stopWatching()
        this.events = []
        this.pods = null
        const update = () => this.zone.run(() => this.updateRelated())

        this.eventsWatcher = this.cluster.watch(findKind('events')!, eventsQuery(this.kind, this.obj))
        this.eventsWatcher.changed$.pipe(auditTime(UPDATE_INTERVAL)).subscribe(update)
        const podsQuery = relatedPodsQuery(this.kind, this.obj)
        if (podsQuery) {
            this.pods = []
            this.podsWatcher = this.cluster.watch(findKind('pods')!, podsQuery)
            this.podsWatcher.changed$.pipe(auditTime(UPDATE_INTERVAL)).subscribe(update)
        }
    }

    private updateRelated (): void {
        this.events = (this.eventsWatcher?.items ?? [])
            .sort((a, b) => (Date.parse(eventTime(b) ?? '') || 0) - (Date.parse(eventTime(a) ?? '') || 0))
        if (this.podsWatcher) {
            this.pods = this.podsWatcher.items.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
        }
    }

    private stopWatching (): void {
        this.eventsWatcher?.stop()
        this.podsWatcher?.stop()
        this.eventsWatcher = null
        this.podsWatcher = null
    }

    // Template helpers

    age (timestamp: string|undefined): string {
        return formatAge(timestamp)
    }

    eventAge (event: KubeObject): string {
        return formatAge(eventTime(event))
    }

    podStatus (pod: KubeObject): string {
        return podStatus(pod)
    }

    podTone (pod: KubeObject): Tone {
        return podTone(pod)
    }

    podReady (pod: KubeObject): string {
        return podReady(pod).join('/')
    }

    podRestarts (pod: KubeObject): number {
        return podRestarts(pod)
    }

    // Actions

    openContainer (container: string, mode: KubeTerminalMode, previous = false): void {
        this.container.emit({ pod: this.obj, container, mode, previous })
    }

    /** Shells and logs of a related pod go to its first container */
    openPod (pod: KubeObject, mode: KubeTerminalMode): void {
        this.container.emit({ pod, container: podContainers(pod)[0], mode, previous: false })
    }

    toggleReveal (entry: DataEntry): void {
        if (this.revealed.has(entry.key)) {
            this.revealed.delete(entry.key)
        } else {
            this.revealed.add(entry.key)
        }
    }

    copy (text: string): void {
        this.platform.setClipboard({ text })
    }
}
