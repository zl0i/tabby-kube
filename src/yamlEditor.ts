import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { load } from 'js-yaml'
import { NotificationsService, PlatformService } from 'tabby-core'
import { KubeObject } from './api'
import { KubeCluster, toYaml } from './kube/cluster'
import { KubeApiError } from './kube/http'
import { KubeResourceKind } from './kube/resources'

const POLL_INTERVAL = 1000

/** Checks an edited object before it is sent: it must still be the same object */
export function checkEdited (kind: KubeResourceKind, original: KubeObject, edited: unknown): KubeObject {
    if (!edited || typeof edited !== 'object' || Array.isArray(edited)) {
        throw new Error('The file is not a Kubernetes object')
    }
    const obj = edited as KubeObject
    const metadata = (obj.metadata as unknown ?? {}) as Partial<KubeObject['metadata']>
    const same = obj.apiVersion === kind.apiVersion
        && obj.kind === kind.kind
        && metadata.name === original.metadata.name
        && (metadata.namespace ?? '') === (original.metadata.namespace ?? '')
    if (!same) {
        throw new Error(`The kind, name and namespace can't change: it has to stay ${kind.kind} ${original.metadata.name}`)
    }
    return obj
}

/**
 * Edits objects as YAML files in the app the OS opens .yaml files with, as `kubectl edit` does.
 * Every save replaces the object in the cluster, as long as nobody changed it there meanwhile.
 * Watches by polling the modification time, which survives editors that save by replacing the file.
 */
export class YamlEditor {
    private stopWatching: (() => void)[] = []
    private tempDirs: string[] = []

    constructor (
        private getCluster: () => KubeCluster|null,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) { }

    async edit (kind: KubeResourceKind, obj: KubeObject): Promise<void> {
        const cluster = this.getCluster()
        if (!cluster) {
            return
        }
        const fresh = await cluster.read(kind, obj)
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tabby-kube-'))
        this.tempDirs.push(tempDir)
        const filePath = path.join(tempDir, `${kind.kind.toLowerCase()}-${obj.metadata.name}.yaml`)
        await fs.promises.writeFile(filePath, toYaml(kind, fresh))

        // The version the next save builds on: the one read, then each one saved
        let baseVersion = fresh.metadata.resourceVersion
        let saves = Promise.resolve()
        const save = async () => {
            const text = await fs.promises.readFile(filePath, 'utf-8')
            try {
                const edited = checkEdited(kind, fresh, load(text))
                edited.metadata.resourceVersion = baseVersion
                const saved = await this.getCluster()!.replace(kind, edited)
                baseVersion = saved.metadata.resourceVersion
                this.notifications.notice(`Saved ${kind.kind} ${obj.metadata.name}`)
            } catch (e) {
                if (e instanceof KubeApiError && e.statusCode === 409) {
                    this.notifications.error(`${obj.metadata.name} has changed in the cluster since it was opened. Edit it again to start from the current version.`)
                } else {
                    this.notifications.error(`Could not save ${obj.metadata.name}: ${e.message}`)
                }
            }
        }
        const listener = (current: fs.Stats, previous: fs.Stats) => {
            if (current.mtimeMs !== previous.mtimeMs && current.mtimeMs) {
                saves = saves.then(save)
            }
        }
        fs.watchFile(filePath, { interval: POLL_INTERVAL }, listener)
        this.stopWatching.push(() => fs.unwatchFile(filePath, listener))

        this.platform.openPath(filePath)
        this.notifications.info(`Saving ${path.basename(filePath)} applies it to the cluster while this tab is open`)
    }

    /** Stops applying changes and deletes the local copies */
    dispose (): void {
        for (const stop of this.stopWatching) {
            stop()
        }
        this.stopWatching = []
        for (const dir of this.tempDirs) {
            // A file still open in an editor can't be deleted on Windows; the OS cleans the temp folder later
            fs.promises.rm(dir, { recursive: true, force: true }).catch(() => null)
        }
        this.tempDirs = []
    }
}
