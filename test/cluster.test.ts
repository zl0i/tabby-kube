// Read-only checks against a real cluster: nothing here creates, changes or deletes objects.
//   KUBE_TEST_CONTEXT     kubeconfig context to use (the tests are skipped without it)
//   KUBE_TEST_KUBECONFIG  kubeconfig file; the default one otherwise
//   KUBE_TEST_EXEC        namespace/pod/container with a shell, to run `echo` in; the exec test is skipped without it
//   KUBE_TEST_METRICS     set when the cluster has metrics-server, to require usage figures
import './fakeTabby'
import { after, describe, test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as http from 'node:http'
import { KubeTerminalProfileOptions } from '../src/api'
import { KubeCluster } from '../src/kube/cluster'
import { listCustomKinds } from '../src/kube/discovery'
import { KubeApiError } from '../src/kube/http'
import { fetchNodeUsage, fetchPodUsage } from '../src/kube/metrics'
import { eventsQuery, relatedPodsQuery } from '../src/kube/related'
import { PortForwarder } from '../src/kube/portForward'
import { findKind, podStatus } from '../src/kube/resources'
import { ResourceWatcher } from '../src/kube/watcher'
import { KubeLogsSession, KubeShellSession } from '../src/sessions'

/** What the stand-in BaseSession of fakeTabby.ts collects */
interface FakeBaseSession {
    printed: string
    ended: Promise<void>
}

const context = process.env.KUBE_TEST_CONTEXT
const target = { kubeconfig: process.env.KUBE_TEST_KUBECONFIG ?? '', context: context ?? '' }

function waitFor (condition: () => boolean, timeout = 15000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const check = () => {
            if (condition()) {
                resolve()
            } else if (Date.now() - start > timeout) {
                reject(new Error('Timed out'))
            } else {
                setTimeout(check, 50)
            }
        }
        check()
    })
}

function terminalOptions (namespace: string, pod: string, container: string, extra: Partial<KubeTerminalProfileOptions> = {}): KubeTerminalProfileOptions {
    return { ...target, mode: 'shell', namespace, pod, container, command: '', tailLines: 5, previous: false, ...extra }
}

describe('a real cluster', { skip: !context && 'KUBE_TEST_CONTEXT is not set' }, () => {
    const cluster = new KubeCluster(target)
    let watcher: ResourceWatcher|null = null

    after(() => watcher?.stop())

    test('answers with its version', async () => {
        assert.match(await cluster.getVersion(), /^v\d+\.\d+/)
        assert.equal(cluster.contextName, context)
    })

    test('lists namespaces', async () => {
        const namespaces = await cluster.listNamespaces()
        assert.ok(namespaces?.includes('kube-system'))
    })

    test('watches the pods of a namespace', async () => {
        watcher = cluster.watch(findKind('pods')!, 'kube-system')
        await waitFor(() => watcher!.loaded || !!watcher!.error)
        assert.equal(watcher.error, null)
        assert.ok(watcher.items.length > 0)
        assert.ok(watcher.items.every(x => x.metadata.namespace === 'kube-system'))
        // The watch that follows the list stays up
        await new Promise(resolve => setTimeout(resolve, 1500))
        assert.equal(watcher.error, null)
        watcher.stop()
        watcher = null
    })

    test('reports API errors with the server message', async () => {
        await assert.rejects(
            cluster.read(findKind('pods')!, { metadata: { name: 'no-such-pod-tabby-kube', namespace: 'kube-system', uid: '' } }),
            (e: KubeApiError) => e.statusCode === 404 && e.message.includes('not found'),
        )
    })

    test('streams the logs of a container', async () => {
        const watch = cluster.watch(findKind('pods')!, 'kube-system')
        await waitFor(() => watch.loaded)
        const pod = watch.items.find(x => podStatus(x) === 'Running')!
        watch.stop()

        const session = new KubeLogsSession(null as any, cluster.kc, terminalOptions(
            'kube-system', pod.metadata.name, pod.spec.containers[0].name, { mode: 'logs', tailLines: 3 },
        ))
        const fake = session as unknown as FakeBaseSession
        await session.start()
        assert.ok(session.open)
        await waitFor(() => fake.printed.length > 0)
        // Lines end in CRLF for the terminal
        assert.doesNotMatch(fake.printed, /[^\r]\n/)
        session.kill()
        await fake.ended
    })

    test('explains why a shell can not start', async () => {
        const watch = cluster.watch(findKind('pods')!, 'kube-system')
        await waitFor(() => watch.loaded)
        const pod = watch.items.find(x => podStatus(x) === 'Running')!
        watch.stop()

        const session = new KubeShellSession(null as any, cluster.kc, terminalOptions('kube-system', pod.metadata.name, 'no-such-container'))
        await assert.rejects(session.start({ columns: 80, rows: 24 }), /has no container "no-such-container"/)
    })

    const exec = process.env.KUBE_TEST_EXEC?.split('/')
    test('runs a command in a container', { skip: !exec && 'KUBE_TEST_EXEC is not set' }, async () => {
        const [namespace, pod, container] = exec!
        const session = new KubeShellSession(null as any, cluster.kc, terminalOptions(namespace, pod, container, { command: 'echo tabby-kube-ok' }))
        const fake = session as unknown as FakeBaseSession
        await session.start({ columns: 80, rows: 24 })
        await fake.ended
        assert.match(fake.printed, /tabby-kube-ok/)
    })

    // CoreDNS serves its metrics on 9153, behind the kube-dns service, in k3s and kind alike
    function httpGet (port: number, path: string): Promise<{ status: number, body: string }> {
        return new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port, path }, response => {
                let body = ''
                response.on('data', chunk => { body += chunk })
                response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
            }).on('error', reject)
        })
    }

    for (const [kindId, name] of [['services', 'kube-dns'], ['deployments', 'coredns']]) {
        test(`forwards a port of ${kindId}/${name}`, async () => {
            const forwarder = new PortForwarder(cluster.kc, cluster.contextName, {
                kind: findKind(kindId)!, namespace: 'kube-system', name, port: 9153,
            })
            await forwarder.start(0)
            try {
                assert.ok(forwarder.localPort > 0)
                // Connections in a row, each with a stream of its own; the port headers arrive with the
                // handshake now and then, so a few tries catch them being mistaken for data
                for (let i = 0; i < 10; i++) {
                    const response = await httpGet(forwarder.localPort, '/metrics')
                    assert.equal(response.status, 200)
                    assert.match(response.body, /coredns_/)
                }
                assert.equal(forwarder.error, null)
            } finally {
                forwarder.stop()
            }
        })
    }

    test('reports a forward to a port nothing listens on', async () => {
        const pods = cluster.watch(findKind('pods')!, 'kube-system')
        await waitFor(() => pods.loaded)
        const coredns = pods.items.find(x => x.metadata.labels?.['k8s-app'] === 'kube-dns' && podStatus(x) === 'Running')!
        pods.stop()

        const forwarder = new PortForwarder(cluster.kc, cluster.contextName, {
            kind: findKind('pods')!, namespace: 'kube-system', name: coredns.metadata.name, port: 1,
        })
        await forwarder.start(0)
        try {
            await httpGet(forwarder.localPort, '/').catch(() => null)
            await waitFor(() => !!forwarder.error)
            assert.match(forwarder.error!, /refused|failed|error/i)
        } finally {
            forwarder.stop()
        }
    })

    test('checks a replacement with a dry run, and refuses one from an old version', async () => {
        const kind = findKind('configmaps')!
        const current = await cluster.read(kind, { metadata: { name: 'coredns', namespace: 'kube-system', uid: '' } })
        // dryRun=All: the server validates and answers, but stores nothing
        const checked = await cluster.replace(kind, current, { dryRun: true })
        assert.equal(checked.metadata.name, 'coredns')
        await assert.rejects(
            cluster.replace(kind, { ...current, metadata: { ...current.metadata, resourceVersion: '1' } }, { dryRun: true }),
            (e: KubeApiError) => e.statusCode === 409,
        )
    })

    test('lists the kinds of custom resources, and their objects', async () => {
        const kinds = await listCustomKinds(cluster.kc)
        assert.ok(Array.isArray(kinds))
        for (const kind of kinds.slice(0, 5)) {
            const watch = cluster.watch(kind, null)
            await waitFor(() => watch.loaded || !!watch.error)
            watch.stop()
            assert.equal(watch.error, null, kind.id)
        }
    })

    test('reads resource usage when the cluster has metrics', async () => {
        const nodes = await fetchNodeUsage(cluster.kc)
        if (!process.env.KUBE_TEST_METRICS) {
            // Without metrics-server, usage is just missing
            assert.ok(nodes === null || nodes.size > 0)
            return
        }
        assert.ok(nodes && nodes.size > 0)
        assert.ok([...nodes.values()].every(x => x.cpu > 0 && x.memory > 0))
        const pods = await fetchPodUsage(cluster.kc, 'kube-system')
        assert.ok(pods && [...pods.keys()].every(x => x.startsWith('kube-system/')))
    })

    async function loaded (collection: ResourceWatcher): Promise<ResourceWatcher> {
        await waitFor(() => collection.loaded || !!collection.error)
        collection.stop()
        assert.equal(collection.error, null)
        return collection
    }

    test('finds the pods of a service and of a node', async () => {
        const service = await cluster.read(findKind('services')!, { metadata: { name: 'kube-dns', namespace: 'kube-system', uid: '' } })
        const pods = await loaded(cluster.watch(findKind('pods')!, relatedPodsQuery(findKind('services')!, service)!))
        assert.ok(pods.items.length > 0)
        assert.ok(pods.items.every(x => x.metadata.labels?.['k8s-app'] === 'kube-dns'))

        const nodeName = pods.items[0].spec.nodeName
        const node = await cluster.read(findKind('nodes')!, { metadata: { name: nodeName, uid: '' } })
        const onNode = await loaded(cluster.watch(findKind('pods')!, relatedPodsQuery(findKind('nodes')!, node)!))
        assert.ok(onNode.items.some(x => x.metadata.uid === pods.items[0].metadata.uid))
        assert.ok(onNode.items.every(x => x.spec.nodeName === nodeName))
    })

    test('lists the events about an object only', async () => {
        const all = await loaded(cluster.watch(findKind('events')!, null))
        const event = all.items.find(x => x.involvedObject?.uid && x.involvedObject?.namespace)
        if (!event) {
            return
        }
        const about = await loaded(cluster.watch(findKind('events')!, eventsQuery(findKind('pods')!, {
            metadata: { name: event.involvedObject.name, namespace: event.involvedObject.namespace, uid: event.involvedObject.uid },
        })))
        assert.ok(about.items.length > 0)
        assert.ok(about.items.every(x => x.involvedObject.uid === event.involvedObject.uid))
    })
})
