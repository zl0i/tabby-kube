// Read-only checks against a real cluster: nothing here creates, changes or deletes objects.
//   KUBE_TEST_CONTEXT     kubeconfig context to use (the tests are skipped without it)
//   KUBE_TEST_KUBECONFIG  kubeconfig file; the default one otherwise
//   KUBE_TEST_EXEC        namespace/pod/container with a shell, to run `echo` in; the exec test is skipped without it
import './fakeTabby'
import { after, describe, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { KubeTerminalProfileOptions } from '../src/api'
import { KubeCluster } from '../src/kube/cluster'
import { KubeApiError } from '../src/kube/http'
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
})
