import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { KubeObject } from '../src/api'
import { describeConditions, describeContainers, describeData, describeProperties } from '../src/kube/describe'
import { eventsQuery, labelSelectorString, relatedPodsQuery } from '../src/kube/related'
import { findKind } from '../src/kube/resources'

function obj (rest: Partial<KubeObject> & { name?: string, namespace?: string }): KubeObject {
    const { name, namespace, ...fields } = rest
    return { metadata: { name: name ?? 'x', uid: 'uid-1', namespace }, ...fields }
}

test('labelSelectorString renders labels and expressions', () => {
    assert.equal(labelSelectorString({ matchLabels: { app: 'web' } }), 'app=web')
    assert.equal(labelSelectorString({
        matchLabels: { app: 'web' },
        matchExpressions: [
            { key: 'tier', operator: 'In', values: ['front', 'edge'] },
            { key: 'env', operator: 'NotIn', values: ['dev'] },
            { key: 'canary', operator: 'Exists' },
            { key: 'legacy', operator: 'DoesNotExist' },
        ],
    }), 'app=web,tier in (front,edge),env notin (dev),canary,!legacy')
    assert.equal(labelSelectorString(undefined), '')
})

test('relatedPodsQuery finds the pods of workloads, services and nodes', () => {
    const deployment = obj({ namespace: 'ns', spec: { selector: { matchLabels: { app: 'web' } } } })
    assert.deepEqual(relatedPodsQuery(findKind('deployments')!, deployment), { namespace: 'ns', labelSelector: 'app=web' })
    assert.deepEqual(relatedPodsQuery(findKind('services')!, obj({ namespace: 'ns', spec: { selector: { app: 'web' } } })), { namespace: 'ns', labelSelector: 'app=web' })
    // A service without a selector
    assert.equal(relatedPodsQuery(findKind('services')!, obj({ namespace: 'ns', spec: {} })), null)
    assert.deepEqual(relatedPodsQuery(findKind('nodes')!, obj({ name: 'n1' })), { namespace: null, fieldSelector: 'spec.nodeName=n1' })
    assert.equal(relatedPodsQuery(findKind('configmaps')!, obj({ namespace: 'ns' })), null)
})

test('eventsQuery matches by UID, or by kind and name for cluster-wide objects', () => {
    assert.deepEqual(eventsQuery(findKind('pods')!, obj({ namespace: 'ns' })), { namespace: 'ns', fieldSelector: 'involvedObject.uid=uid-1' })
    assert.deepEqual(eventsQuery(findKind('nodes')!, obj({ name: 'n1' })), { namespace: null, fieldSelector: 'involvedObject.kind=Node,involvedObject.name=n1' })
})

test('describeContainers shows states, init containers first', () => {
    const pod = obj({
        spec: {
            initContainers: [{ name: 'migrate', image: 'app:1' }],
            containers: [{ name: 'app', image: 'app:1', ports: [{ containerPort: 8080 }] }, { name: 'proxy', image: 'envoy' }],
        },
        status: {
            initContainerStatuses: [{ name: 'migrate', state: { terminated: { exitCode: 0, reason: 'Completed' } } }],
            containerStatuses: [
                { name: 'app', ready: true, restartCount: 2, state: { running: {} } },
                { name: 'proxy', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
            ],
        },
    })
    assert.deepEqual(describeContainers(pod).map(x => [x.name, x.init, x.state, x.tone, x.restarts, x.ports]), [
        ['migrate', true, 'Completed (exit code 0)', 'muted', 0, ''],
        ['app', false, 'Running', 'ok', 2, '8080/TCP'],
        ['proxy', false, 'CrashLoopBackOff', 'error', 0, ''],
    ])
})

test('describeConditions colors pressure conditions the other way round', () => {
    const node = obj({
        status: {
            conditions: [
                { type: 'Ready', status: 'True' },
                { type: 'MemoryPressure', status: 'False' },
                { type: 'DiskPressure', status: 'True', reason: 'KubeletHasDiskPressure' },
                { type: 'PIDPressure', status: 'Unknown' },
            ],
        },
    })
    assert.deepEqual(describeConditions(node).map(x => [x.type, x.tone]), [
        ['Ready', 'ok'], ['MemoryPressure', 'ok'], ['DiskPressure', 'error'], ['PIDPressure', 'warning'],
    ])
})

test('describeData decodes secrets', () => {
    const secret = obj({ data: { password: Buffer.from('hunter2').toString('base64') } })
    assert.deepEqual(describeData(findKind('secrets')!, secret), [{ key: 'password', value: 'hunter2', secret: true }])
    const configMap = obj({ data: { 'app.conf': 'a=1' }, binaryData: { logo: 'AAA=' } })
    assert.deepEqual(describeData(findKind('configmaps')!, configMap), [
        { key: 'app.conf', value: 'a=1', secret: false },
        { key: 'logo', value: '(binary)', secret: false },
    ])
    assert.deepEqual(describeData(findKind('pods')!, secret), [])
})

test('describeProperties lists what describe shows first', () => {
    const pod = obj({
        spec: { nodeName: 'n1', serviceAccountName: 'default' },
        status: { podIP: '10.0.0.5', qosClass: 'Burstable' },
    })
    ;(pod.metadata as any).ownerReferences = [{ kind: 'ReplicaSet', name: 'web-5d4' }]
    const properties = Object.fromEntries(describeProperties(findKind('pods')!, pod))
    assert.equal(properties['Node'], 'n1')
    assert.equal(properties['Pod IP'], '10.0.0.5')
    assert.equal(properties['Controlled by'], 'ReplicaSet/web-5d4')
    // Missing values are left out
    assert.equal(Object.keys(Object.fromEntries(describeProperties(findKind('pods')!, obj({})))).length, 0)
})
