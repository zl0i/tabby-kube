import * as http from 'http'
import * as https from 'https'
import { createInterface } from 'readline'
import { Readable } from 'stream'
import { KubeConfig } from '@kubernetes/client-node'

/** An API server response other than 2xx, with the message from its Status object */
export class KubeApiError extends Error {
    constructor (message: string, public readonly statusCode: number, public readonly reason?: string) {
        super(message)
    }
}

export type KubeMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface KubeRequestOptions {
    query?: Record<string, string|number|boolean|undefined>
    body?: unknown
    contentType?: string
    /** JSON by default */
    accept?: string
    signal?: AbortSignal
}

async function readText (stream: Readable): Promise<string> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks).toString('utf-8')
}

async function responseError (response: http.IncomingMessage): Promise<KubeApiError> {
    const statusCode = response.statusCode ?? 0
    const text = await readText(response).catch(() => '')
    try {
        const status = JSON.parse(text)
        if (status.message) {
            return new KubeApiError(status.message, statusCode, status.reason)
        }
    } catch { }
    return new KubeApiError(`${statusCode} ${response.statusMessage ?? ''}${text ? ': ' + text.slice(0, 500) : ''}`, statusCode)
}

/**
 * A raw request to the API server, authenticated the way the kubeconfig says (certificates, tokens, exec plugins).
 * Unlike the typed API clients, this keeps objects as the server sends them - the same shape watch events have.
 *
 * It goes through Node's http(s) like the exec WebSocket does, rather than the client's own fetch (undici):
 * in Tabby's renderer the web streams undici builds on are the browser's, and its requests never complete.
 */
export async function kubeRequest (kc: KubeConfig, method: KubeMethod, apiPath: string, options: KubeRequestOptions = {}): Promise<http.IncomingMessage> {
    const cluster = kc.getCurrentCluster()
    if (!cluster) {
        throw new Error('No cluster in the current context')
    }
    const url = new URL(cluster.server.replace(/\/+$/, '') + apiPath)
    for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) {
            url.searchParams.set(key, value.toString())
        }
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const requestOptions: https.RequestOptions = {
        method,
        headers: {
            Accept: options.accept ?? 'application/json',
            ...body !== undefined ? { 'Content-Type': options.contentType ?? 'application/json' } : {},
        },
    }
    // The TLS agent with the cluster's CA and client certificate, and the Authorization header
    await kc.applyToHTTPSOptions(requestOptions)

    options.signal?.throwIfAborted()
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, requestOptions, resolve)
        request.on('error', reject)
        options.signal?.addEventListener('abort', () => request.destroy(new Error('Aborted')), { once: true })
        request.end(body)
    })
    // A response to a request aborted later ends with an error as well
    options.signal?.addEventListener('abort', () => response.destroy(), { once: true })

    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        throw await responseError(response)
    }
    return response
}

export async function kubeJson<T> (kc: KubeConfig, method: KubeMethod, apiPath: string, options?: KubeRequestOptions): Promise<T> {
    const response = await kubeRequest(kc, method, apiPath, options)
    return JSON.parse(await readText(response)) as T
}

/** The lines of a text response that match, without holding the rest (the API server's metrics run to megabytes) */
export async function kubeTextLines (kc: KubeConfig, apiPath: string, filter: (line: string) => boolean): Promise<string[]> {
    const response = await kubeRequest(kc, 'GET', apiPath, { accept: 'text/plain' })
    const lines: string[] = []
    for await (const line of createInterface(response)) {
        if (filter(line)) {
            lines.push(line)
        }
    }
    return lines
}
