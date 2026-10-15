import * as http from 'http'
import { KubeConfig } from '@kubernetes/client-node'
import { kubeRequest } from './http'

export interface LogStreamOptions {
    container: string
    follow?: boolean
    /** Only the last lines */
    tailLines?: number
    /** The previous, terminated instance of the container */
    previous?: boolean
}

/** A container's log, as the server streams it */
export function openLogStream (kc: KubeConfig, namespace: string, pod: string, options: LogStreamOptions, signal?: AbortSignal): Promise<http.IncomingMessage> {
    return kubeRequest(kc, 'GET', `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log`, {
        query: {
            container: options.container,
            follow: options.follow ? true : undefined,
            tailLines: options.tailLines && options.tailLines > 0 ? options.tailLines : undefined,
            previous: options.previous ? true : undefined,
        },
        signal,
    })
}

/** Cuts text arriving in chunks into lines, holding a line back until its end arrives */
export class LineSplitter {
    private rest = ''

    push (chunk: string): string[] {
        const lines = (this.rest + chunk).split('\n')
        this.rest = lines.pop()!
        return lines.map(x => x.replace(/\r$/, ''))
    }

    /** What is left once the stream ends without a final newline */
    flush (): string|null {
        const rest = this.rest
        this.rest = ''
        return rest ? rest : null
    }
}

/**
 * A pod's name without its workload's, which every pod of it shares:
 * web-5d4f7c9b8-x2kq of deployment web becomes 5d4f7c9b8-x2kq
 */
export function shortPodName (pod: string, workload: string): string {
    return pod.startsWith(workload + '-') && pod.length > workload.length + 1 ? pod.slice(workload.length + 1) : pod
}

/** Colors of the pods' prefixes, as stern picks them: cyan, green, yellow, magenta, blue, red */
const PREFIX_COLORS = [36, 32, 33, 35, 34, 31]

export function colorPrefix (label: string, index: number): string {
    return `\x1b[${PREFIX_COLORS[index % PREFIX_COLORS.length]}m${label}\x1b[0m `
}
