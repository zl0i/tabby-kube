# tabby-kube

Kubernetes cluster browser for [Tabby](https://tabby.sh), in the spirit of Lens: resources of a cluster in a tab, shells and logs of containers in Tabby's own terminal tabs.

## Features

- **Clusters as profiles**: every context of your kubeconfig (`$KUBECONFIG`, or `~/.kube/config`) shows up in the profile list as is. Clusters from other kubeconfig files can be added as profiles
- **Live resource tables**: pods, deployments, stateful sets, daemon sets, jobs, cron jobs, services, ingresses, config maps, secrets, volume claims, volumes, nodes, namespaces and events. They follow the cluster through watches instead of polling, and show what `kubectl get` shows - pod statuses such as `CrashLoopBackOff` or `Init:1/2` included
- **Custom resources**: every CRD of the cluster, grouped by API group, with the columns its definition declares - as `kubectl get` shows them
- **CPU and memory** of pods and nodes (nodes also as a share of what they can allocate), when the cluster runs metrics-server
- **One namespace or all**, a filter over every column, sorting by any column
- **Details** next to the table, as `kubectl describe` tells them and kept live: the main properties, containers with their states, conditions, the pods a workload, service or node runs (click one to go to it), labels, annotations, data of config maps and secrets (hidden until shown, copied decoded), and the events about the object. Its YAML on a tab of its own
- **Quick navigation**: `:` picks a kind of resources by typing its name, `/` jumps to the filter, Escape closes the details. Tabby's command palette has *Kubernetes: show resources…* and *Kubernetes: switch namespace…*
- **Helm releases**: chart, app version, status and revision of each release, its history, notes, values given (and the chart's defaults) and manifest - read from the secrets Helm keeps them in, no `helm` needed
- **Shell** into any container (bash where the image has it, sh otherwise) and **logs**, followed, including those of the previous instance of a restarted container - in terminal tabs, with Tabby's search, splits, copying and color schemes
- **Logs of all the pods** of a deployment, stateful set, daemon set, job or service in one tab, each line behind its pod's name in a color of its own, as stern does. Pods that come later, as in a rollout, join in; restarted containers too
- **Shell on a node**: starts a privileged pod on it that enters the node's namespaces (as Lens and `kubectl debug node` do), and deletes it when the shell ends. The image (any with `nsenter`; `alpine:3.20` by default) and the namespace (`kube-system`, which has to allow privileged pods) are set in the cluster's profile
- **Port forwarding** to pods, services, deployments, stateful sets and daemon sets - through a pod the service or workload selects, as kubectl does, and through the next one when that pod goes away. The forwards stay up while Tabby runs, listed under Network → Port forwards
- **Edit YAML** in the app your OS opens `.yaml` files with: each save is applied to the cluster, and refused when the object has changed there in the meantime
- **Restart** (as `kubectl rollout restart`) and **scale** workloads, **delete** objects - each after a confirmation that names the context
- Open tabs come back after a restart, cluster tabs at the same view and namespace

No `kubectl` needed: the plugin talks to the API server itself, with the credentials of the kubeconfig - client certificates, tokens, and `exec` plugins such as `aws eks get-token`, `gke-gcloud-auth-plugin` or `kubelogin` (these have to be installed and in `PATH`, as for kubectl).

## Usage

Open the profile list (the button next to the tabs) and pick a context. Right-click a row for its actions, or click it to see its details.

For a cluster from another kubeconfig file: Settings → Profiles & connections → New profile → **Kubernetes cluster**, and set the file there. A profile can also fix the context and the namespace to open.

## Installation

Settings → Plugins → search for `tabby-kube`. Or download the package from the [releases](https://github.com/zl0i/tabby-kube/releases) and run `npm install <path to tabby-kube-x.y.z.tgz>` in Tabby's plugin folder (`%APPDATA%\tabby\plugins` on Windows, `~/.config/tabby/plugins` on Linux, `~/Library/Application Support/tabby/plugins` on macOS).

## Development

```
npm install
npm run build        # or: npm run watch
npm run lint
npm test
```

Copy `package.json` and `dist` to `<Tabby's plugin folder>/node_modules/tabby-kube` and restart Tabby to try a build.

`npm test` runs unit tests. With a cluster, it also checks the plugin against it - read-only, nothing there is created, changed or deleted:

```
KUBE_TEST_CONTEXT=my-context npm test
```

`KUBE_TEST_KUBECONFIG` picks another kubeconfig file, and `KUBE_TEST_EXEC=namespace/pod/container` names a container with a shell to run `echo` in.

Tabby runs plugins in Electron's renderer, where the Node.js networking code of the Kubernetes client meets browser globals. Hence requests go through Node's `https` rather than the client's own fetch, and `shims/nodeRuntimeLoader.cjs` gives some dependencies Node's timers.

## License

MIT
