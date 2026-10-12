import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { KubeObject } from '../src/api'
import { customKind, evaluateColumn } from '../src/kube/discovery'
import { formatCpu, formatMemory, parseQuantity, usageColumns } from '../src/kube/metrics'

const certificate: KubeObject = {
    metadata: { name: 'site', uid: 'u', creationTimestamp: new Date(Date.now() - 3 * 3600 * 1000).toISOString() },
    spec: { secretName: 'site-tls', dnsNames: ['a.example', 'b.example'], issuerRef: { name: 'letsencrypt' } },
    status: { conditions: [{ type: 'Issuing', status: 'False' }, { type: 'Ready', status: 'True', message: 'Up to date' }] },
}

const crd: KubeObject = {
    metadata: { name: 'certificates.cert-manager.io', uid: 'c' },
    spec: {
        group: 'cert-manager.io',
        scope: 'Namespaced',
        names: { kind: 'Certificate', plural: 'certificates' },
        versions: [
            { name: 'v1alpha2', served: false, storage: false },
            {
                name: 'v1',
                served: true,
                storage: true,
                additionalPrinterColumns: [
                    { jsonPath: '.status.conditions[?(@.type=="Ready")].status', name: 'Ready', type: 'string' },
                    { jsonPath: '.spec.secretName', name: 'Secret', type: 'string' },
                    { jsonPath: '.metadata.creationTimestamp', name: 'Age', type: 'date' },
                ],
            },
        ],
    },
}

test('evaluateColumn reads printer column paths as kubectl does', () => {
    assert.equal(evaluateColumn(certificate, '.spec.secretName'), 'site-tls')
    assert.equal(evaluateColumn(certificate, '.status.conditions[?(@.type=="Ready")].status'), 'True')
    assert.equal(evaluateColumn(certificate, '.spec.dnsNames'), 'a.example,b.example')
    assert.equal(evaluateColumn(certificate, '.spec.issuerRef'), '{"name":"letsencrypt"}')
    assert.equal(evaluateColumn(certificate, '.spec.missing'), '')
    assert.equal(evaluateColumn(certificate, '.status.conditions[?(@.type=="Nope")].status'), '')
})

test('customKind takes the stored version and its printer columns', () => {
    const kind = customKind(crd)!
    assert.equal(kind.id, 'certificates.cert-manager.io')
    assert.equal(kind.apiVersion, 'cert-manager.io/v1')
    assert.equal(kind.group, 'cert-manager.io')
    assert.equal(kind.namespaced, true)
    assert.deepEqual(kind.columns.map(x => x.title), ['Ready', 'Secret', 'Age'])
    assert.deepEqual(kind.columns.map(x => x.value(certificate)), ['True', 'site-tls', '3h'])
    assert.equal(kind.columns[0].tone?.(certificate), 'ok')
})

test('customKind adds an age column, and skips definitions with nothing served', () => {
    const plain = customKind({ ...crd, spec: { ...crd.spec, scope: 'Cluster', versions: [{ name: 'v1', served: true, storage: true }] } })!
    assert.equal(plain.namespaced, false)
    assert.deepEqual(plain.columns.map(x => x.title), ['Age'])
    assert.equal(customKind({ ...crd, spec: { ...crd.spec, versions: [{ name: 'v1', served: false }] } }), null)
})

test('parseQuantity understands decimal and binary suffixes', () => {
    assert.equal(parseQuantity('250m'), 0.25)
    assert.equal(parseQuantity('2'), 2)
    assert.equal(parseQuantity('1.5'), 1.5)
    assert.ok(Math.abs(parseQuantity('123456789n') - 0.123456789) < 1e-12)
    assert.equal(parseQuantity('500u'), 0.0005)
    assert.equal(parseQuantity('128Mi'), 128 * 2 ** 20)
    assert.equal(parseQuantity('4Gi'), 4 * 2 ** 30)
    assert.equal(parseQuantity('16316388Ki'), 16316388 * 1024)
    assert.equal(parseQuantity('1G'), 1e9)
    assert.equal(parseQuantity('1e3'), 1000)
    assert.equal(parseQuantity(''), 0)
    assert.equal(parseQuantity(undefined), 0)
    assert.equal(parseQuantity('12Zi'), 0)
})

test('usage is formatted as kubectl top does', () => {
    assert.equal(formatCpu(0.25), '250m')
    assert.equal(formatCpu(1.5), '1500m')
    assert.equal(formatMemory(128 * 2 ** 20), '128Mi')
    assert.equal(formatMemory(12.5 * 2 ** 30), '12.5Gi')
})

test('node usage columns show the share of allocatable', () => {
    const node: KubeObject = { metadata: { name: 'n1', uid: 'n' }, status: { allocatable: { cpu: '4', memory: '8Gi' } } }
    const usage = new Map([['n1', { cpu: 3.8, memory: 2 * 2 ** 30 }]])
    const [cpu, memory] = usageColumns('nodes', () => usage)
    assert.equal(cpu.value(node), '3800m (95%)')
    assert.equal(cpu.tone?.(node), 'error')
    assert.equal(memory.value(node), '2048Mi (25%)')
    assert.equal(memory.tone?.(node), null)

    const pod: KubeObject = { metadata: { name: 'p', namespace: 'ns', uid: 'p' } }
    const [podCpu] = usageColumns('pods', () => new Map([['ns/p', { cpu: 0.01, memory: 0 }]]))
    assert.equal(podCpu.value(pod), '10m')
    // Before the first poll
    assert.equal(usageColumns('pods', () => null)[0].value(pod), '')
})
