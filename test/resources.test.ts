import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { KubeObject } from '../src/api'
import { findKind, formatAge, podContainers, podReady, podRestarts, podStatus, resourcePath, RESOURCE_KINDS } from '../src/kube/resources'

function pod (status: any, spec: any = { containers: [{ name: 'app' }] }, metadata: any = {}): KubeObject {
    return { metadata: { name: 'p', uid: 'u', ...metadata }, spec, status }
}

test('formatAge prints ages the way kubectl does', () => {
    const now = Date.parse('2026-01-10T00:00:00Z')
    const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
    assert.equal(formatAge(undefined, now), '')
    assert.equal(formatAge(ago(45), now), '45s')
    assert.equal(formatAge(ago(7 * 60 + 12), now), '7m12s')
    assert.equal(formatAge(ago(40 * 60), now), '40m')
    assert.equal(formatAge(ago(5 * 3600 + 30 * 60), now), '5h30m')
    assert.equal(formatAge(ago(20 * 3600), now), '20h')
    assert.equal(formatAge(ago(3 * 86400 + 4 * 3600), now), '3d4h')
    assert.equal(formatAge(ago(120 * 86400), now), '120d')
    assert.equal(formatAge(ago(1000 * 86400), now), '2y')
    // Clock skew: a timestamp slightly in the future
    assert.equal(formatAge(ago(-5), now), '0s')
})

test('podStatus follows kubectl', () => {
    assert.equal(podStatus(pod({ phase: 'Running', containerStatuses: [{ ready: true, state: { running: {} } }] })), 'Running')
    assert.equal(podStatus(pod({ phase: 'Pending' })), 'Pending')
    assert.equal(podStatus(pod({
        phase: 'Running',
        containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    })), 'CrashLoopBackOff')
    assert.equal(podStatus(pod({
        phase: 'Failed',
        containerStatuses: [{ state: { terminated: { exitCode: 137, reason: 'OOMKilled' } } }],
    })), 'OOMKilled')
    assert.equal(podStatus(pod({
        phase: 'Failed',
        containerStatuses: [{ state: { terminated: { exitCode: 2 } } }],
    })), 'ExitCode:2')
    assert.equal(podStatus(pod({ phase: 'Running' }, undefined, { deletionTimestamp: '2026-01-01T00:00:00Z' })), 'Terminating')
    assert.equal(podStatus(pod({ phase: 'Failed', reason: 'Evicted' })), 'Evicted')
})

test('podStatus shows init containers while they run', () => {
    const spec = { containers: [{ name: 'app' }], initContainers: [{ name: 'a' }, { name: 'b' }] }
    assert.equal(podStatus(pod({
        phase: 'Pending',
        initContainerStatuses: [
            { state: { terminated: { exitCode: 0 } } },
            { state: { running: {} } },
        ],
    }, spec)), 'Init:1/2')
    assert.equal(podStatus(pod({
        phase: 'Pending',
        initContainerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }],
    }, spec)), 'Init:CrashLoopBackOff')
    assert.equal(podStatus(pod({
        phase: 'Pending',
        initContainerStatuses: [{ state: { terminated: { exitCode: 1, reason: 'Error' } } }],
    }, spec)), 'Init:Error')
})

test('a pod whose sidecar completed while the main container runs is Running', () => {
    assert.equal(podStatus(pod({
        phase: 'Running',
        containerStatuses: [
            { ready: true, state: { running: {} } },
            { ready: false, state: { terminated: { exitCode: 0, reason: 'Completed' } } },
        ],
    })), 'Running')
})

test('ready, restarts and containers of a pod', () => {
    const p = pod({
        containerStatuses: [{ ready: true, restartCount: 2 }, { ready: false, restartCount: 3 }],
    }, { containers: [{ name: 'app' }, { name: 'proxy' }], initContainers: [{ name: 'migrate' }] })
    assert.deepEqual(podReady(p), [1, 2])
    assert.equal(podRestarts(p), 5)
    assert.deepEqual(podContainers(p), ['app', 'proxy', 'migrate'])
})

test('resourcePath builds core, group, namespaced and cluster-wide paths', () => {
    assert.equal(resourcePath(findKind('pods')!, null), '/api/v1/pods')
    assert.equal(resourcePath(findKind('pods')!, 'kube-system'), '/api/v1/namespaces/kube-system/pods')
    assert.equal(resourcePath(findKind('deployments')!, 'a b', 'web'), '/apis/apps/v1/namespaces/a%20b/deployments/web')
    // A namespace doesn't apply to cluster-wide kinds
    assert.equal(resourcePath(findKind('nodes')!, 'default', 'n1'), '/api/v1/nodes/n1')
})

test('every column of every kind copes with an empty object', () => {
    const empty: KubeObject = { metadata: { name: 'x', uid: 'u' } }
    for (const kind of RESOURCE_KINDS) {
        for (const column of kind.columns) {
            assert.equal(typeof column.value(empty), 'string', `${kind.id}: ${column.title}`)
            column.tone?.(empty)
            column.sortValue?.(empty)
        }
    }
})
