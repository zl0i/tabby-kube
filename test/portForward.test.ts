import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { KubeObject } from '../src/api'
import { forwardablePorts, labelSelector, pickPod, servicePortInPod } from '../src/kube/portForward'
import { findKind } from '../src/kube/resources'
import { checkEdited } from '../src/yamlEditor'

function obj (name: string, rest: Partial<KubeObject> = {}): KubeObject {
    return { metadata: { name, uid: name, namespace: 'ns' }, ...rest }
}

const pod = obj('web-1', {
    spec: { containers: [{ name: 'app', ports: [{ containerPort: 8080, name: 'http' }, { containerPort: 53, protocol: 'UDP' }] }] },
    status: { phase: 'Running', containerStatuses: [{ ready: true }] },
})

test('forwardablePorts lists TCP ports of containers, templates and services', () => {
    assert.deepEqual(forwardablePorts(findKind('pods')!, pod), [{ port: 8080, name: 'http' }])
    assert.deepEqual(forwardablePorts(findKind('deployments')!, obj('web', { spec: { template: { spec: pod.spec } } })), [{ port: 8080, name: 'http' }])
    assert.deepEqual(forwardablePorts(findKind('services')!, obj('web', {
        spec: { ports: [{ port: 80, name: 'http', targetPort: 'http' }, { port: 53, protocol: 'UDP' }] },
    })), [{ port: 80, name: 'http' }])
    assert.deepEqual(forwardablePorts(findKind('pods')!, obj('bare')), [])
})

test('labelSelector joins labels', () => {
    assert.equal(labelSelector({ app: 'web', tier: 'front' }), 'app=web,tier=front')
    assert.equal(labelSelector(undefined), '')
})

test('pickPod prefers a ready running pod', () => {
    const notReady = obj('a', { status: { phase: 'Running', containerStatuses: [{ ready: false }] }, spec: { containers: [{}] } })
    const pending = obj('b', { status: { phase: 'Pending' } })
    const ready = obj('c', { status: { phase: 'Running', containerStatuses: [{ ready: true }] }, spec: { containers: [{}] } })
    assert.equal(pickPod([pending, notReady, ready])?.metadata.name, 'c')
    assert.equal(pickPod([pending, notReady])?.metadata.name, 'a')
    assert.equal(pickPod([pending]), null)
})

test('servicePortInPod follows targetPort by number, by name, or defaults to the port', () => {
    const service = obj('web', {
        spec: { ports: [{ port: 80, targetPort: 'http' }, { port: 81, targetPort: 9000 }, { port: 82, targetPort: '9001' }, { port: 83 }] },
    })
    assert.equal(servicePortInPod(service, 80, pod), 8080)
    assert.equal(servicePortInPod(service, 81, pod), 9000)
    assert.equal(servicePortInPod(service, 82, pod), 9001)
    assert.equal(servicePortInPod(service, 83, pod), 83)
    assert.throws(() => servicePortInPod(obj('x', { spec: { ports: [{ port: 1, targetPort: 'nope' }] } }), 1, pod), /no port named "nope"/)
})

test('checkEdited keeps an edit to the same object only', () => {
    const kind = findKind('configmaps')!
    const original = obj('settings')
    const edited = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'ns' }, data: { a: '1' } }
    assert.equal(checkEdited(kind, original, edited), edited)
    assert.throws(() => checkEdited(kind, original, { ...edited, metadata: { name: 'other', namespace: 'ns' } }), /can't change/)
    assert.throws(() => checkEdited(kind, original, { ...edited, kind: 'Secret' }), /can't change/)
    assert.throws(() => checkEdited(kind, original, { apiVersion: 'v1', kind: 'ConfigMap' }), /can't change/)
    assert.throws(() => checkEdited(kind, original, 'text'), /not a Kubernetes object/)
    assert.throws(() => checkEdited(kind, original, null), /not a Kubernetes object/)
})
