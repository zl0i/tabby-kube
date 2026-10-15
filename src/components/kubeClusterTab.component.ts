import { Component, ElementRef, HostListener, Injector, Input, NgZone, ViewChild } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { auditTime } from 'rxjs'
import {
    BaseTabComponent,
    MenuItemOptions,
    NotificationsService,
    PlatformService,
    ProfilesService,
    PromptModalComponent,
    RecoveryToken,
    SelectorOption,
    SelectorService,
} from 'tabby-core'
import { KubeContainerMode, KubeObject, KubeProfile, KubeTarget } from '../api'
import { KubeCluster, toYaml } from '../kube/cluster'
import { CUSTOM_SECTION, listCustomKinds } from '../kube/discovery'
import { fetchNodeUsage, fetchPodUsage, hasUsage, Usage, usageColumns } from '../kube/metrics'
import { canForward, forwardablePorts, PortForwarder } from '../kube/portForward'
import { findKind, KubeColumn, KubeResourceKind, podContainers, podRestarts, RESOURCE_KINDS, Tone } from '../kube/resources'
import { ResourceWatcher } from '../kube/watcher'
import { hasWorkloadLogs } from '../kube/related'
import { containerProfile, nodeShellProfile, workloadLogsProfile } from '../profiles'
import { PortForwardsService } from '../services/portForwards.service'
import { YamlEditor } from '../yamlEditor'
import { ContainerRequest, DetailsAction } from './kubeDetails.component'
import { PortForwardChoice, PortForwardModalComponent } from './portForwardModal.component'

/** Redraws at most this often while objects change */
const UPDATE_INTERVAL = 250
/** Ages tick even when nothing changes */
const AGE_REFRESH_INTERVAL = 5000
/** metrics-server refreshes every 15 s by default */
const USAGE_INTERVAL = 15000
/** The state's kind for the port forwards view */
const PORT_FORWARDS_VIEW = 'port-forwards'

export interface KubeClusterTabState {
    kind: string
    namespace: string
}

interface Section {
    title: string
    kinds: KubeResourceKind[]
}

interface CustomGroup {
    group: string
    kinds: KubeResourceKind[]
    expanded: boolean
}

interface Cell {
    text: string
    tone: Tone|null
}

interface Row {
    obj: KubeObject
    uid: string
    cells: Cell[]
    sortValues: (string|number)[]
}

const NAME_COLUMN: KubeColumn = { title: 'Name', value: obj => obj.metadata.name, wide: true }
const NAMESPACE_COLUMN: KubeColumn = { title: 'Namespace', value: obj => obj.metadata.namespace ?? '' }

/** @hidden */
@Component({
    selector: 'kube-cluster-tab',
    templateUrl: './kubeClusterTab.component.pug',
    styleUrls: ['./kubeClusterTab.component.scss'],
})
export class KubeClusterTabComponent extends BaseTabComponent {
    @Input() profile: KubeProfile
    @Input() state: KubeClusterTabState|undefined
    cluster: KubeCluster|null = null
    version = ''
    connecting = false
    error: string|null = null
    /** Null when the credentials may not list namespaces; the namespace is typed in then */
    namespaces: string[]|null = []
    /** Empty means all namespaces */
    namespace = ''
    kind: KubeResourceKind = RESOURCE_KINDS[0]
    view: 'resources' | 'port-forwards' = 'resources'
    sections: Section[] = []
    customGroups: CustomGroup[] = []
    columns: KubeColumn[] = []
    rows: Row[] = []
    totalCount = 0
    filterText = ''
    sortColumn = 'Name'
    sortDescending = false
    selectedUid: string|null = null
    @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>
    @ViewChild('tableWrap') tableWrap?: ElementRef<HTMLElement>
    /** Brings the selected row into view once it is listed, after jumping to it */
    private revealSelected = false
    private watcher: ResourceWatcher|null = null
    private ageTimer: ReturnType<typeof setInterval>|null = null
    private yamlEditor: YamlEditor
    private customKinds: KubeResourceKind[] = []
    /** A custom kind to open once the cluster's kinds are known (from the recovered state) */
    private pendingKindId: string|null = null
    private metricsSupported = false
    private usage: Map<string, Usage>|null = null
    private usageTimer: ReturnType<typeof setInterval>|null = null

    constructor (
        injector: Injector,
        private zone: NgZone,
        private ngbModal: NgbModal,
        private notifications: NotificationsService,
        private profiles: ProfilesService,
        private platform: PlatformService,
        public portForwards: PortForwardsService,
        private selector: SelectorService,
    ) {
        super(injector)
        this.yamlEditor = new YamlEditor(() => this.cluster, platform, notifications)
        for (const kind of RESOURCE_KINDS) {
            let section = this.sections.find(x => x.title === kind.section)
            if (!section) {
                section = { title: kind.section, kinds: [] }
                this.sections.push(section)
            }
            section.kinds.push(kind)
        }
    }

    async ngOnInit (): Promise<void> {
        this.setTitle(this.profile.name)
        this.kind = findKind(this.state?.kind ?? '') ?? RESOURCE_KINDS[0]
        if (this.state?.kind === PORT_FORWARDS_VIEW) {
            this.view = 'port-forwards'
        } else if (this.state?.kind && this.kind.id !== this.state.kind) {
            this.pendingKindId = this.state.kind
        }
        // Connections come and go outside of Angular's change detection
        this.subscribeUntilDestroyed(this.portForwards.changed$.pipe(auditTime(UPDATE_INTERVAL)), () => this.zone.run(() => null))
        this.applyDefaultSort()
        this.ageTimer = setInterval(() => this.updateRows(), AGE_REFRESH_INTERVAL)
        await this.connect()
    }

    get selected (): KubeObject|null {
        return this.rows.find(x => x.uid === this.selectedUid)?.obj ?? null
    }

    get loading (): boolean {
        return !!this.watcher && !this.watcher.loaded
    }

    get watchError (): string|null {
        return this.watcher?.error ?? null
    }

    // Connection

    async connect (): Promise<void> {
        this.stopWatching()
        this.cluster = null
        this.error = null
        this.connecting = true
        try {
            const cluster = new KubeCluster(this.profile.options)
            this.version = await cluster.getVersion()
            this.namespace = this.state?.namespace ?? (this.profile.options.namespace || cluster.contextNamespace)
            const [namespaces, customKinds, nodeUsage] = await Promise.all([
                cluster.listNamespaces(),
                listCustomKinds(cluster.kc),
                fetchNodeUsage(cluster.kc).catch(() => null),
            ])
            this.namespaces = namespaces
            this.setCustomKinds(customKinds)
            this.metricsSupported = !!nodeUsage
            this.cluster = cluster
            const pending = this.customKinds.find(x => x.id === this.pendingKindId)
            this.pendingKindId = null
            if (pending) {
                this.kind = pending
                this.applyDefaultSort()
                this.expandGroupOf(pending)
            }
            this.watch()
        } catch (e) {
            console.error('Could not connect to the cluster', e)
            this.cluster = null
            this.error = e.message
        } finally {
            this.connecting = false
        }
    }

    // Navigation

    private setCustomKinds (kinds: KubeResourceKind[]): void {
        this.customKinds = kinds
        this.customGroups = []
        for (const kind of kinds) {
            let group = this.customGroups.find(x => x.group === kind.group)
            if (!group) {
                group = { group: kind.group!, kinds: [], expanded: false }
                this.customGroups.push(group)
            }
            group.kinds.push(kind)
        }
    }

    private expandGroupOf (kind: KubeResourceKind): void {
        const group = this.customGroups.find(x => x.group === kind.group)
        if (group) {
            group.expanded = true
        }
    }

    toggleGroup (group: CustomGroup): void {
        group.expanded = !group.expanded
    }

    selectKind (kind: KubeResourceKind): void {
        const wasResources = this.view === 'resources'
        this.view = 'resources'
        if (kind === this.kind && wasResources) {
            return
        }
        this.kind = kind
        this.selectedUid = null
        this.applyDefaultSort()
        this.watch()
    }

    showPortForwards (): void {
        this.view = 'port-forwards'
        this.selectedUid = null
    }

    selectNamespace (namespace: string): void {
        this.namespace = namespace.trim()
        this.selectedUid = null
        this.watch()
    }

    private watch (): void {
        this.stopWatching()
        if (!this.cluster) {
            return
        }
        const columns = [...this.kind.columns]
        if (this.metricsSupported && hasUsage(this.kind.id)) {
            const age = columns.findIndex(x => x.title === 'Age')
            columns.splice(age < 0 ? columns.length : age, 0, ...usageColumns(this.kind.id, () => this.usage))
        }
        this.columns = [
            ...this.kind.hideName ? [] : [this.kind.nameColumn ?? NAME_COLUMN],
            ...this.kind.namespaced && !this.namespace ? [NAMESPACE_COLUMN] : [],
            ...columns,
        ]
        this.rows = []
        this.totalCount = 0
        this.watcher = this.cluster.watch(this.kind, {
            namespace: this.kind.namespaced ? this.namespace || null : null,
            labelSelector: this.kind.labelSelector,
        })
        // Watch events arrive from network streams, outside of Angular's change detection
        this.watcher.changed$.pipe(auditTime(UPDATE_INTERVAL)).subscribe(() => this.zone.run(() => this.updateRows()))
        this.pollUsage()
    }

    /** Usage isn't watchable; it is polled while pods or nodes are shown */
    private pollUsage (): void {
        if (!this.metricsSupported || !hasUsage(this.kind.id)) {
            return
        }
        const kind = this.kind
        const namespace = this.namespace || null
        const poll = async () => {
            try {
                const usage = kind.id === 'pods'
                    ? await fetchPodUsage(this.cluster!.kc, namespace)
                    : await fetchNodeUsage(this.cluster!.kc)
                if (kind === this.kind && this.usageTimer) {
                    this.usage = usage
                    this.updateRows()
                }
            } catch (e) {
                console.warn('Could not get resource usage', e)
            }
        }
        this.usageTimer = setInterval(poll, USAGE_INTERVAL)
        poll()
    }

    private stopWatching (): void {
        this.watcher?.stop()
        this.watcher = null
        if (this.usageTimer) {
            clearInterval(this.usageTimer)
            this.usageTimer = null
        }
        this.usage = null
    }

    // Table

    onFilterChange (): void {
        this.updateRows()
    }

    clearFilter (): void {
        this.filterText = ''
        this.updateRows()
    }

    sortBy (column: KubeColumn): void {
        if (this.sortColumn === column.title) {
            this.sortDescending = !this.sortDescending
        } else {
            this.sortColumn = column.title
            this.sortDescending = false
        }
        this.updateRows()
    }

    sortIcon (column: KubeColumn): string {
        if (this.sortColumn !== column.title) {
            return ''
        }
        return this.sortDescending ? 'fas fa-sort-down' : 'fas fa-sort-up'
    }

    private applyDefaultSort (): void {
        this.sortColumn = this.kind.defaultSort?.column ?? 'Name'
        this.sortDescending = this.kind.defaultSort?.descending ?? false
    }

    updateRows (): void {
        const listed = this.watcher?.items ?? []
        const objects = this.kind.transform ? this.kind.transform(listed) : listed
        this.totalCount = objects.length
        const query = this.filterText.trim().toLowerCase()
        const sortIndex = Math.max(0, this.columns.findIndex(x => x.title === this.sortColumn))

        const rows: Row[] = objects.map(obj => ({
            obj,
            uid: obj.metadata.uid,
            cells: this.columns.map(column => ({ text: column.value(obj), tone: column.tone?.(obj) ?? null })),
            sortValues: this.columns.map(column => column.sortValue?.(obj) ?? column.value(obj)),
        }))
        const filtered = query
            ? rows.filter(row => row.cells.some(cell => cell.text.toLowerCase().includes(query)))
            : rows
        filtered.sort((a, b) => {
            const x = a.sortValues[sortIndex]
            const y = b.sortValues[sortIndex]
            const result = typeof x === 'number' && typeof y === 'number'
                ? x - y
                : String(x).localeCompare(String(y), undefined, { numeric: true })
            return (this.sortDescending ? -result : result) || a.obj.metadata.name.localeCompare(b.obj.metadata.name)
        })
        this.rows = filtered

        if (this.revealSelected && this.selected) {
            this.revealSelected = false
            // After the rows are rendered
            setTimeout(() => this.tableWrap?.nativeElement.querySelector('tr.selected')?.scrollIntoView({ block: 'center' }))
        }
    }

    trackRow (_index: number, row: Row): string {
        return row.uid
    }

    select (row: Row): void {
        this.selectedUid = this.selectedUid === row.uid ? null : row.uid
        this.updateRows()
    }

    closeDetails (): void {
        this.selectedUid = null
    }

    // Actions

    get isPods (): boolean {
        return this.kind.id === 'pods'
    }

    hasRestarted (pod: KubeObject): boolean {
        return podRestarts(pod) > 0
    }

    /** For terminal tabs: the context by name, so that they stay with this cluster when the current context changes */
    private get terminalTarget (): KubeTarget {
        return { kubeconfig: this.profile.options.kubeconfig, context: this.cluster!.contextName }
    }

    openContainer (pod: KubeObject, container: string, mode: KubeContainerMode, previous = false): void {
        this.profiles.openNewTabForProfile(containerProfile(
            this.terminalTarget,
            pod.metadata.namespace!,
            pod.metadata.name,
            container,
            mode,
            { previous },
        ))
    }

    onContainer (request: ContainerRequest): void {
        this.openContainer(request.pod, request.container, request.mode, request.previous)
    }

    /** Shows a pod among all pods, from the pods of a workload, service or node */
    goToPod (pod: KubeObject): void {
        this.selectKind(findKind('pods')!)
        if (this.namespace && this.namespace !== pod.metadata.namespace) {
            this.selectNamespace(pod.metadata.namespace!)
        }
        this.filterText = ''
        this.selectedUid = pod.metadata.uid
        this.revealSelected = true
    }

    hasWorkloadLogs (): boolean {
        return hasWorkloadLogs(this.kind)
    }

    openWorkloadLogs (obj: KubeObject): void {
        this.profiles.openNewTabForProfile(workloadLogsProfile(this.terminalTarget, this.kind, obj.metadata.namespace!, obj.metadata.name))
    }

    async openNodeShell (node: KubeObject): Promise<void> {
        const { nodeShellImage, nodeShellNamespace } = this.profile.options
        const confirmed = (await this.platform.showMessageBox({
            type: 'warning',
            message: `Open a shell on node ${node.metadata.name}?`,
            detail: `This starts a privileged pod (${nodeShellImage}) in ${nodeShellNamespace} with full access to the node, and deletes it when the shell closes.\n\nContext: ${this.cluster?.contextName}`,
            buttons: ['Open shell', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
        })).response === 0
        if (confirmed) {
            this.profiles.openNewTabForProfile(nodeShellProfile(this.terminalTarget, node.metadata.name, nodeShellImage, nodeShellNamespace))
        }
    }

    onAction (obj: KubeObject, action: DetailsAction): void {
        const actions: Record<DetailsAction, (x: KubeObject) => Promise<void>> = {
            logs: async x => this.openWorkloadLogs(x),
            'node-shell': x => this.openNodeShell(x),
            edit: x => this.editYaml(x),
            forward: x => this.portForward(x),
            restart: x => this.restart(x),
            scale: x => this.scale(x),
            'delete': x => this.delete(x),
        }
        actions[action](obj)
    }

    // Quick navigation

    /** Every kind, the custom ones included, to jump to by typing its name */
    async pickKind (): Promise<void> {
        const options: SelectorOption<void>[] = [
            ...this.sections.flatMap(section => section.kinds.map(kind => ({
                name: kind.title,
                group: section.title,
                callback: () => this.selectKind(kind),
            }))),
            {
                name: 'Port forwards',
                group: 'Network',
                callback: () => this.showPortForwards(),
            },
            ...this.customGroups.flatMap(group => group.kinds.map(kind => ({
                name: kind.title,
                description: kind.group,
                group: CUSTOM_SECTION,
                callback: () => {
                    this.expandGroupOf(kind)
                    this.selectKind(kind)
                },
            }))),
        ]
        await this.selector.show('Show resources', options).catch(() => null)
    }

    async pickNamespace (): Promise<void> {
        const options: SelectorOption<void>[] = [
            { name: 'All namespaces', icon: 'fas fa-asterisk', callback: () => this.selectNamespace('') },
            ...(this.namespaces ?? []).map(ns => ({
                name: ns,
                icon: ns === this.namespace ? 'fas fa-check' : undefined,
                callback: () => this.selectNamespace(ns),
            })),
            // Typed in, for credentials that may not list namespaces
            { name: 'Namespace', freeInputPattern: 'Namespace "%s"', icon: 'fas fa-pen', callback: (text?: string) => this.selectNamespace(text ?? '') },
        ]
        await this.selector.show('Switch namespace', options).catch(() => null)
    }

    /** ":" for kinds, "/" for the filter, Escape to close the details - while no field has focus */
    @HostListener('document:keydown', ['$event'])
    onKeyDown (event: KeyboardEvent): void {
        const target = event.target as HTMLElement|null
        if (!this.hasFocus || event.ctrlKey || event.altKey || event.metaKey || target?.closest('input, textarea, select, ngb-modal-window')) {
            return
        }
        if (event.key === ':') {
            event.preventDefault()
            this.pickKind()
        } else if (event.key === '/') {
            event.preventDefault()
            this.filterInput?.nativeElement.focus()
        } else if (event.key === 'Escape' && this.selectedUid) {
            this.closeDetails()
        }
    }

    showContextMenu (row: Row, event: MouseEvent): void {
        event.preventDefault()
        this.selectedUid = row.uid
        this.updateRows()
        const items = this.actionsFor(row.obj)
        if (items.length) {
            this.platform.popupContextMenu(items, event)
        }
    }

    private actionsFor (obj: KubeObject): MenuItemOptions[] {
        const items: MenuItemOptions[] = []
        if (this.isPods) {
            const containers = podContainers(obj)
            const perContainer = (mode: KubeContainerMode, previous = false): Partial<MenuItemOptions> => containers.length === 1
                ? { click: () => this.openContainer(obj, containers[0], mode, previous) }
                : { submenu: containers.map(c => ({ label: c, click: () => this.openContainer(obj, c, mode, previous) })) }
            items.push(
                { label: 'Shell', ...perContainer('shell') },
                { label: 'Logs', ...perContainer('logs') },
            )
            if (this.hasRestarted(obj)) {
                items.push({ label: 'Previous logs', ...perContainer('logs', true) })
            }
            items.push({ type: 'separator' })
        }
        if (this.kind.id === 'nodes') {
            items.push({ label: 'Shell', click: () => this.openNodeShell(obj) }, { type: 'separator' })
        }
        if (hasWorkloadLogs(this.kind)) {
            items.push({ label: 'Logs of all pods', click: () => this.openWorkloadLogs(obj) })
        }
        if (canForward(this.kind)) {
            items.push({ label: 'Port forward…', click: () => this.portForward(obj) })
        }
        if (this.kind.restartable) {
            items.push({ label: 'Restart', click: () => this.restart(obj) })
        }
        if (this.kind.scalable) {
            items.push({ label: 'Scale…', click: () => this.scale(obj) })
        }
        if (this.kind.readOnly) {
            return items
        }
        items.push(
            { label: 'Copy name', click: () => this.platform.setClipboard({ text: obj.metadata.name }) },
            { label: 'Copy YAML', click: () => this.platform.setClipboard({ text: toYaml(this.kind, obj) }) },
            { label: 'Edit YAML', click: () => this.editYaml(obj) },
            { type: 'separator' },
            { label: 'Delete', click: () => this.delete(obj) },
        )
        return items
    }

    canForward (): boolean {
        return canForward(this.kind)
    }

    async portForward (obj: KubeObject): Promise<void> {
        const modal = this.ngbModal.open(PortForwardModalComponent)
        modal.componentInstance.title = `Forward a port of ${obj.metadata.name}`
        modal.componentInstance.ports = forwardablePorts(this.kind, obj)
        const choice: PortForwardChoice|null = await modal.result.catch(() => null)
        if (!choice || !this.cluster) {
            return
        }
        try {
            const forwarder = await this.portForwards.start(this.cluster.kc, this.cluster.contextName, {
                kind: this.kind,
                namespace: obj.metadata.namespace!,
                name: obj.metadata.name,
                port: choice.remotePort,
            }, choice.localPort)
            this.notifications.notice(`Forwarding 127.0.0.1:${forwarder.localPort} to ${obj.metadata.name}:${choice.remotePort}`)
        } catch (e) {
            this.notifications.error(e.code === 'EADDRINUSE'
                ? `Port ${choice.localPort} is taken on this computer; choose another local port, or 0 for any free one`
                : e.message)
        }
    }

    forwardAddress (forwarder: PortForwarder): string {
        return `127.0.0.1:${forwarder.localPort}`
    }

    openForward (forwarder: PortForwarder): void {
        this.platform.openExternal(`http://${this.forwardAddress(forwarder)}`)
    }

    copyForward (forwarder: PortForwarder): void {
        this.platform.setClipboard({ text: this.forwardAddress(forwarder) })
    }

    stopForward (forwarder: PortForwarder): void {
        this.portForwards.stop(forwarder)
    }

    async editYaml (obj: KubeObject): Promise<void> {
        try {
            await this.yamlEditor.edit(this.kind, obj)
        } catch (e) {
            this.notifications.error(e.message)
        }
    }

    async restart (obj: KubeObject): Promise<void> {
        if (!await this.confirm(`Restart the pods of ${this.kind.kind.toLowerCase()} ${obj.metadata.name}?`, 'Restart')) {
            return
        }
        await this.run(() => this.cluster!.restart(this.kind, obj), `Restarting ${obj.metadata.name}`)
    }

    async scale (obj: KubeObject): Promise<void> {
        const modal = this.ngbModal.open(PromptModalComponent)
        modal.componentInstance.prompt = `Replicas of ${obj.metadata.name}`
        modal.componentInstance.value = String(obj.spec?.replicas ?? 0)
        const result = await modal.result.catch(() => null)
        const replicas = Number(result?.value)
        if (!result?.value || !Number.isInteger(replicas) || replicas < 0) {
            return
        }
        await this.run(() => this.cluster!.scale(this.kind, obj, replicas), `Scaling ${obj.metadata.name} to ${replicas}`)
    }

    async delete (obj: KubeObject): Promise<void> {
        const where = obj.metadata.namespace ? ` in ${obj.metadata.namespace}` : ''
        if (!await this.confirm(`Delete ${this.kind.kind.toLowerCase()} ${obj.metadata.name}${where}?`, 'Delete')) {
            return
        }
        await this.run(() => this.cluster!.delete(this.kind, obj), `Deleting ${obj.metadata.name}`)
    }

    private async confirm (message: string, action: string): Promise<boolean> {
        return (await this.platform.showMessageBox({
            type: 'warning',
            message,
            detail: `Context: ${this.cluster?.contextName}`,
            buttons: [action, 'Cancel'],
            defaultId: 1,
            cancelId: 1,
        })).response === 0
    }

    private async run (action: () => Promise<void>, notice: string): Promise<void> {
        try {
            await action()
            this.notifications.notice(notice)
        } catch (e) {
            this.notifications.error(e.message)
        }
    }

    // Tab

    async getRecoveryToken (): Promise<RecoveryToken> {
        return {
            type: 'app:kube-tab',
            profile: this.profile,
            state: { kind: this.view === 'port-forwards' ? PORT_FORWARDS_VIEW : this.kind.id, namespace: this.namespace } as KubeClusterTabState,
        }
    }

    destroy (skipDestroyedEvent = false): void {
        this.stopWatching()
        this.yamlEditor.dispose()
        if (this.ageTimer) {
            clearInterval(this.ageTimer)
        }
        super.destroy(skipDestroyedEvent)
    }
}
