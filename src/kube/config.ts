import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { KubeConfig } from '@kubernetes/client-node'
import { KubeTarget } from '../api'

export function expandHome (filePath: string): string {
    return filePath.replace(/^~(?=$|[\\/])/, os.homedir())
}

/** Whether there is any kubeconfig to read without one being configured */
function hasDefaultKubeconfig (): boolean {
    return !!process.env.KUBECONFIG || fs.existsSync(path.join(os.homedir(), '.kube', 'config'))
}

export function loadKubeConfig (target: KubeTarget): KubeConfig {
    const kc = new KubeConfig()
    if (target.kubeconfig) {
        kc.loadFromFile(expandHome(target.kubeconfig))
    } else if (hasDefaultKubeconfig()) {
        // Merges every file in $KUBECONFIG, as kubectl does
        kc.loadFromDefault()
    } else {
        throw new Error('No kubeconfig found: set $KUBECONFIG, create ~/.kube/config or choose a file in the profile')
    }
    if (target.context) {
        if (!kc.getContextObject(target.context)) {
            throw new Error(`There is no context "${target.context}" in the kubeconfig`)
        }
        kc.setCurrentContext(target.context)
    }
    if (!kc.getCurrentCluster()) {
        throw new Error(`The context "${kc.getCurrentContext()}" has no cluster`)
    }
    return kc
}

/** Context names in a kubeconfig; empty when there is no kubeconfig or it can't be read */
export function listContexts (kubeconfig: string): string[] {
    if (!kubeconfig && !hasDefaultKubeconfig()) {
        return []
    }
    try {
        const kc = new KubeConfig()
        if (kubeconfig) {
            kc.loadFromFile(expandHome(kubeconfig))
        } else {
            kc.loadFromDefault()
        }
        return kc.getContexts().map(x => x.name)
    } catch (e) {
        console.warn('Could not read the kubeconfig', e)
        return []
    }
}
