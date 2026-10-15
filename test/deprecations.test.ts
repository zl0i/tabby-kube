import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import {
    ApiCheckContext,
    ApiUsage,
    checkUsage,
    compareVersions,
    findDeprecation,
    manifestResources,
    parseRequestedDeprecatedApis,
    parseVersion,
} from '../src/kube/deprecations'

const context = (version: string, served: string[]|null = null): ApiCheckContext => ({
    version: parseVersion(version)!,
    served: served ? new Set(served) : null,
    deprecatedCustom: new Map([['example.com/v1beta1/Widget', 'example.com/v1beta1 Widget is deprecated; use v1']]),
})

const usage = (apiVersion: string, kind: string): ApiUsage => ({ apiVersion, kind, name: 'x', source: 'helm' })

test('versions parse from server versions and compare by minor', () => {
    assert.deepEqual(parseVersion('v1.32.13+k3s1'), { major: 1, minor: 32 })
    assert.deepEqual(parseVersion('1.25'), { major: 1, minor: 25 })
    assert.equal(parseVersion('latest'), null)
    assert.ok(compareVersions({ major: 1, minor: 9 }, { major: 1, minor: 25 }) < 0)
    assert.equal(compareVersions({ major: 1, minor: 25 }, { major: 1, minor: 25 }), 0)
})

test('the table knows removed APIs and their replacements', () => {
    assert.deepEqual(findDeprecation('autoscaling/v2beta1', 'HorizontalPodAutoscaler'), {
        apiVersion: 'autoscaling/v2beta1', kind: 'HorizontalPodAutoscaler', deprecatedIn: '1.22', removedIn: '1.25', replacement: 'autoscaling/v2',
    })
    assert.equal(findDeprecation('policy/v1beta1', 'PodSecurityPolicy')!.replacement, null)
    assert.equal(findDeprecation('apps/v1', 'Deployment'), undefined)
})

test('checkUsage: removed by the cluster version, by discovery, or by the target version', () => {
    // Removed before the cluster's version
    const hpa = checkUsage(usage('autoscaling/v2beta1', 'HorizontalPodAutoscaler'), context('v1.32.1'))!
    assert.equal(hpa.status, 'removed')
    assert.equal(hpa.detail, 'Removed in 1.25')
    assert.equal(hpa.replacement, 'autoscaling/v2')

    // Not served, though the table doesn't know it: a CRD version gone
    const gone = checkUsage(usage('cert-manager.io/v1alpha2', 'Certificate'), context('v1.32.1', ['v1', 'cert-manager.io/v1']))!
    assert.equal(gone.status, 'removed')
    assert.equal(gone.detail, 'Not served by this cluster')

    // Served now, gone in the version to upgrade to
    const flow = usage('flowcontrol.apiserver.k8s.io/v1beta3', 'FlowSchema')
    assert.equal(checkUsage(flow, context('v1.30.0'))!.status, 'deprecated')
    assert.equal(checkUsage(flow, context('v1.30.0'), { major: 1, minor: 32 })!.status, 'removed-in-target')
    assert.equal(checkUsage(flow, context('v1.30.0'))!.detail, 'Deprecated in 1.29, removed in 1.32')

    // Not deprecated yet in that version
    assert.equal(checkUsage(usage('autoscaling/v2beta2', 'HorizontalPodAutoscaler'), context('v1.22.0')), null)
    // Current APIs
    assert.equal(checkUsage(usage('apps/v1', 'Deployment'), context('v1.32.0', ['apps/v1'])), null)
    // Deprecated by a CRD
    assert.equal(checkUsage(usage('example.com/v1beta1', 'Widget'), context('v1.32.0'))!.detail, 'example.com/v1beta1 Widget is deprecated; use v1')
    // Deprecated with no removal planned
    assert.equal(checkUsage(usage('v1', 'Endpoints'), context('v1.33.0'))!.detail, 'Deprecated in 1.33')
})

test('checkUsage takes the API server\'s word for requested APIs', () => {
    const requested: ApiUsage = { apiVersion: 'flowcontrol.apiserver.k8s.io/v1beta3', kind: 'flowschemas', name: '', source: 'requested', removedRelease: '1.32' }
    assert.equal(checkUsage(requested, context('v1.31.0'))!.status, 'deprecated')
    assert.equal(checkUsage(requested, context('v1.31.0'), { major: 1, minor: 32 })!.status, 'removed-in-target')
    const forever: ApiUsage = { apiVersion: 'v1', kind: 'componentstatuses', name: '', source: 'requested' }
    assert.equal(checkUsage(forever, context('v1.31.0'))!.detail, 'Deprecated, no removal planned')
})

test('manifestResources reads every object of a Helm manifest', () => {
    const manifest = [
        '---',
        '# Source: app/templates/hpa.yaml',
        'apiVersion: autoscaling/v2beta1',
        'kind: HorizontalPodAutoscaler',
        'metadata:',
        '  name: web',
        '---',
        '# Source: app/templates/empty.yaml',
        '---',
        'apiVersion: v1',
        'kind: Service',
        'metadata:',
        '  name: web',
        '  namespace: other',
    ].join('\n')
    assert.deepEqual(manifestResources(manifest), [
        { apiVersion: 'autoscaling/v2beta1', kind: 'HorizontalPodAutoscaler', name: 'web', namespace: undefined },
        { apiVersion: 'v1', kind: 'Service', name: 'web', namespace: 'other' },
    ])
    assert.deepEqual(manifestResources('key: [unclosed'), [])
})

test('parseRequestedDeprecatedApis reads the API server metric', () => {
    const metrics = [
        '# HELP apiserver_requested_deprecated_apis [STABLE] Gauge of deprecated APIs that have been requested',
        'apiserver_requested_deprecated_apis{group="policy",removed_release="1.25",resource="podsecuritypolicies",subresource="",version="v1beta1"} 1',
        'apiserver_requested_deprecated_apis{group="",removed_release="",resource="endpoints",subresource="",version="v1"} 1',
        'apiserver_request_total{code="200"} 5',
    ].join('\n')
    assert.deepEqual(parseRequestedDeprecatedApis(metrics), [
        { apiVersion: 'policy/v1beta1', kind: 'podsecuritypolicies', name: '', source: 'requested', removedRelease: '1.25' },
        { apiVersion: 'v1', kind: 'endpoints', name: '', source: 'requested', removedRelease: undefined },
    ])
})
