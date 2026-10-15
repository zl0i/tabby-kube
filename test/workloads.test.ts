import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as zlib from 'zlib'
import { KubeObject } from '../src/api'
import { describeRelease } from '../src/kube/describe'
import { decodeRelease, HelmRelease, latestRevisions } from '../src/kube/helm'
import { colorPrefix, LineSplitter, shortPodName } from '../src/kube/logs'
import { isRunning, nodeShellPod, podProgress, podStartProblem } from '../src/kube/nodeShell'
import { findKind } from '../src/kube/resources'

test('LineSplitter holds a line back until it ends', () => {
    const lines = new LineSplitter()
    assert.deepEqual(lines.push('first\nsec'), ['first'])
    assert.deepEqual(lines.push('ond\r\nthird\n'), ['second', 'third'])
    assert.deepEqual(lines.push('last'), [])
    assert.equal(lines.flush(), 'last')
    assert.equal(lines.flush(), null)
})

test('shortPodName drops the workload name all its pods share', () => {
    assert.equal(shortPodName('web-5d4f7c9b8-x2kq', 'web'), '5d4f7c9b8-x2kq')
    assert.equal(shortPodName('db-0', 'db'), '0')
    assert.equal(shortPodName('other-1', 'web'), 'other-1')
    assert.equal(shortPodName('web-', 'web'), 'web-')
})

test('colorPrefix colors labels in turn', () => {
    assert.equal(colorPrefix('a', 0), '\x1b[36ma\x1b[0m ')
    assert.equal(colorPrefix('a', 6), colorPrefix('a', 0))
})

test('the node shell pod shares the node\'s namespaces and tolerates anything', () => {
    const pod = nodeShellPod('Worker_1.example', 'alpine:3.20')
    assert.equal(pod.metadata.generateName, 'node-shell-worker-1.example-')
    assert.equal(pod.spec.nodeName, 'Worker_1.example')
    assert.equal(pod.spec.hostPID, true)
    assert.equal(pod.spec.hostNetwork, true)
    assert.deepEqual(pod.spec.tolerations, [{ operator: 'Exists' }])
    assert.equal(pod.spec.containers[0].securityContext.privileged, true)
    assert.equal(pod.spec.containers[0].image, 'alpine:3.20')
    assert.equal(pod.metadata.labels['app.kubernetes.io/managed-by'], 'tabby-kube')
})

test('podStartProblem tells a pod that will not run from one that is starting', () => {
    const pod = (status: any): KubeObject => ({ metadata: { name: 'p', uid: 'u' }, status })
    assert.equal(podStartProblem(pod({ phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] })), null)
    assert.match(podStartProblem(pod({ phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff', message: 'not found' } } }] }))!, /ImagePullBackOff: not found/)
    assert.match(podStartProblem(pod({ phase: 'Failed', reason: 'Evicted' }))!, /stopped \(Evicted\)/)
    assert.match(podStartProblem(pod({
        phase: 'Pending',
        conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: 'node is full' }],
    }))!, /can't be scheduled: node is full/)
    assert.equal(isRunning(pod({ phase: 'Running', containerStatuses: [{ state: { running: {} } }] })), true)
    assert.equal(isRunning(pod({ phase: 'Running', containerStatuses: [{ state: { waiting: {} } }] })), false)
    assert.equal(podProgress(pod({ phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ContainerCreating' } } }] })), 'ContainerCreating')
    assert.equal(podProgress(pod({})), 'Pending')
})

const release: HelmRelease = {
    name: 'web',
    namespace: 'apps',
    version: 3,
    info: { status: 'deployed', last_deployed: '2026-01-01T00:00:00Z', description: 'Upgrade complete', notes: 'Visit http://web' },
    chart: { metadata: { name: 'nginx', version: '15.1.0', appVersion: '1.25.3' }, values: { replicas: 1 } },
    config: { replicas: 3 },
    manifest: 'kind: Deployment',
}

/** A secret as Helm writes it: the release gzipped and base64-encoded, in data the API base64-encodes again */
function helmSecret (r: HelmRelease, status: string, uid = `${r.name}-${r.version}`): KubeObject {
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ ...r, info: { ...r.info, status } }))).toString('base64')
    return {
        metadata: {
            name: `sh.helm.release.v1.${r.name}.v${r.version}`,
            namespace: r.namespace,
            uid,
            resourceVersion: '1',
            labels: { owner: 'helm', name: r.name, version: String(r.version), status },
        },
        type: 'helm.sh/release.v1',
        data: { release: Buffer.from(payload).toString('base64') },
    }
}

test('decodeRelease reads what Helm stores, and copes with garbage', () => {
    const decoded = decodeRelease(helmSecret(release, 'deployed'))!
    assert.equal(decoded.chart.metadata.name, 'nginx')
    assert.deepEqual(decoded.config, { replicas: 3 })
    assert.equal(decodeRelease({ metadata: { name: 'x', uid: 'garbage', resourceVersion: '1' }, data: { release: 'bm90IGpzb24=' } }), null)
})

test('the Helm kind lists the newest current revision of each release', () => {
    const failed = helmSecret({ ...release, version: 4 }, 'failed')
    const deployed = helmSecret(release, 'deployed')
    const other = helmSecret({ ...release, name: 'db', version: 1 }, 'deployed')
    const latest = latestRevisions([deployed, failed, other])
    assert.deepEqual(latest.map(x => x.metadata.labels!.version + x.metadata.labels!.status).sort(), ['1deployed', '4failed'])

    const kind = findKind('helmreleases')!
    assert.equal(kind.readOnly, true)
    const cells = Object.fromEntries([kind.nameColumn!, ...kind.columns].map(c => [c.title, c.value(failed)]))
    assert.equal(cells['Release'], 'web')
    assert.equal(cells['Revision'], '4')
    assert.equal(cells['Chart'], 'nginx-15.1.0')
    assert.equal(cells['App version'], '1.25.3')
    assert.equal(cells['Status'], 'failed')
    assert.equal(kind.columns.find(c => c.title === 'Status')!.tone!(failed), 'error')
})

test('describeRelease tells what helm status does', () => {
    const properties = Object.fromEntries(describeRelease(release))
    assert.equal(properties['Chart'], 'nginx 15.1.0')
    assert.equal(properties['Revision'], '3')
    assert.equal(properties['Description'], 'Upgrade complete')
})
